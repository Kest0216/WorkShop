// WorkShop launcher: the hub process (node server/index.js) and the startup plan.
//
// Contract (docs/ARCHITECTURE.md sections 3b and 6), as the launcher implements it:
//   start    <node> <base>/server/index.js        no arguments, working folder <base>
//   stdin    a pipe. The launcher never writes to it. End-of-file means "your launcher is gone: shut down".
//   stdout   one line  WORKSHOP_READY http://127.0.0.1:<port>[/path]#k=<ownerKey>
//   stderr   the hub's log. The launcher keeps the last lines for the error view (secrets redacted).
//   lock     <base>/data/run/hub.lock  { "pid": N, "port": N }   one hub per data folder
//   quit     close stdin -> wait 5 s -> SIGTERM -> wait 3 s -> SIGKILL, then the process group and
//            every process seen as a descendant of the hub while it ran (checked once a second, and
//            during the stop). The same sweep runs when the hub ends by itself (crash).
//   own lock <base>/data/run/launcher.lock, held with flock() by the launcher (one launcher per folder).

import Cocoa

// MARK: - Lock file and startup plan (runs off the main thread)

struct LockInfo: Sendable { let pid: pid_t; let port: Int }

func readLock(_ path: String) -> LockInfo? {
    guard let d = FileManager.default.contents(atPath: path),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let pid = o["pid"] as? Int, pid > 1, pid < Int(Int32.max) else { return nil }
    let port = (o["port"] as? Int) ?? 0
    return LockInfo(pid: pid_t(pid), port: (1...65535).contains(port) ? port : 0)
}

/// True when something answers HTTP on 127.0.0.1:<port>. A hub answers 401 here without the owner cookie.
func hubAnswers(port: Int, tries: Int = 3) -> Bool {
    guard port > 0, let url = URL(string: "http://127.0.0.1:\(port)/api/state") else { return false }
    for i in 0..<tries {
        if httpCall("GET", url, timeout: 1.0) != nil { return true }
        if i + 1 < tries { usleep(300_000) }
    }
    return false
}

/// True when the process was started as "... server/index.js".
func looksLikeHub(_ pid: pid_t) -> Bool {
    guard let args = procArgs(pid) else { return false }
    return args.dropFirst().contains { $0.hasSuffix(Cfg.serverRelPath) }
}

/// The WorkShop launcher that started this hub (its parent, or a near ancestor), or nil.
func launcherOwner(of pid: pid_t) -> pid_t? {
    var byPid: [pid_t: ProcEntry] = [:]
    for p in processTable() { byPid[p.pid] = p }
    var cur = byPid[pid]?.ppid ?? 0
    for _ in 0..<4 {
        guard cur > 1 else { return nil }
        if let path = procPath(cur), path.hasSuffix(".app/Contents/MacOS/" + Cfg.appName) { return cur }
        cur = byPid[cur]?.ppid ?? 0
    }
    return nil
}

struct Problem: Sendable {
    let kind: String            // stable id, also used by the tests
    let title: String
    let message: String
    var detail: String? = nil   // shown in a monospaced, selectable box
}

enum StartupPlan: Sendable {
    case start(node: NodeChoice, probe: ShellProbe)
    case problem(Problem)
    case otherLauncher(pid: pid_t, hubPid: pid_t)       // another WorkShop instance owns the hub of this folder
    case hubElsewhere(lock: LockInfo, isHub: Bool)      // a hub runs for this folder, started outside the app
}

/// A live hub for this data folder, if there is one. The owner key lives only in that hub's memory and in
/// the launcher that read its READY line, so this launcher cannot attach to it.
func runningHubPlan(paths: Paths) -> StartupPlan? {
    guard let lock = readLock(paths.lock) else { return nil }
    guard lock.pid != getpid(), pidAlive(lock.pid) else {
        log("startup: stale hub lock ignored (pid \(lock.pid) is not running)")
        return nil
    }
    let isHub = looksLikeHub(lock.pid)
    guard isHub || hubAnswers(port: lock.port) else {
        log("startup: stale hub lock ignored (pid \(lock.pid) is another program and port \(lock.port) does not answer)")
        return nil
    }
    if let owner = launcherOwner(of: lock.pid), owner != getpid() {
        return .otherLauncher(pid: owner, hubPid: lock.pid)
    }
    return .hubElsewhere(lock: lock, isHub: isHub)
}

func makeStartupPlan(paths: Paths) -> StartupPlan {
    // The FIRST touch of the WorkShop folder happens here, on a background thread, and it is a plain read
    // of server/index.js. If macOS wants to ask the owner for folder access, it asks now, and only this
    // thread waits. The window with "Starting WorkShop…" is already on screen.
    if paths.bundle.contains("/AppTranslocation/") {
        return .problem(Problem(kind: "translocated", title: "WorkShop is running from a temporary copy",
            message: "macOS started WorkShop from a read-only temporary place (App Translocation). From there it cannot find its “server” folder.\n\nWhat to do: quit WorkShop. In Finder, drag WorkShop.app out of the WorkShop folder and back in. Or run the command below in Terminal. Then open WorkShop again.",
            detail: "xattr -dr com.apple.quarantine \"<the WorkShop folder>\""))
    }
    let fd = Darwin.open(paths.server, O_RDONLY)
    let openErrno = errno
    if fd >= 0 { close(fd) }
    if fd < 0 && openErrno == ENOENT {
        var isDir: ObjCBool = false
        let serverDir = (paths.server as NSString).deletingLastPathComponent
        if FileManager.default.fileExists(atPath: serverDir, isDirectory: &isDir), isDir.boolValue {
            // The app is in the right folder, but the hub code is incomplete (not installed or not built yet).
            return .problem(Problem(kind: "no-server", title: "WorkShop cannot find its hub",
                message: "WorkShop.app is in the right folder, but the hub's start file is missing:\n\n\(paths.server)\n\nThe “server” folder is there, so the hub code is incomplete (not installed or not finished yet).\n\nWhat to do: put the complete WorkShop hub code in the “server” folder. Then click Try Again."))
        }
        return .problem(Problem(kind: "no-server", title: "WorkShop cannot find its hub",
            message: "WorkShop.app works from inside the WorkShop folder. It looked for this file and did not find it:\n\n\(paths.server)\n\nWhat to do: put WorkShop.app back in the WorkShop folder, next to the “server” folder. Then click Try Again."))
    }
    Log.shared.start(path: paths.log)        // only now: never leave a data/ folder in a wrong place
    if fd < 0 {
        return .problem(Problem(kind: "no-read", title: "WorkShop cannot read its own folder",
            message: "macOS did not let WorkShop read this file:\n\n\(paths.server)\n\(String(cString: strerror(openErrno))) (error \(openErrno))\n\nIf the WorkShop folder is on the Desktop, in Documents or in Downloads, macOS asks once for permission.\n\nWhat to do: open System Settings > Privacy & Security > Files and Folders > WorkShop and turn the folder on. Then click Try Again."))
    }
    // The hub keeps everything in data/. A folder the owner cannot write to (a locked folder, a disk
    // image, a read-only volume) would make the hub fail with a stack trace: say it plainly instead.
    let dataExists = FileManager.default.fileExists(atPath: paths.data)
    let writable = dataExists ? access(paths.data, W_OK | X_OK) == 0 : access(paths.base, W_OK | X_OK) == 0
    if !writable {
        let target = dataExists ? paths.data : paths.base
        return .problem(Problem(kind: "read-only", title: "WorkShop cannot write to its folder",
            message: "WorkShop keeps its work in a “data” folder next to the app, and it cannot write here:\n\n\(target)\n\nThe folder is locked or read-only (for example a disk image, a network share, or a folder without write permission).\n\nWhat to do: copy the whole WorkShop folder to a place you can write to, such as your home folder, and open WorkShop from there. Or fix the folder's permissions in Finder (File > Get Info > Sharing & Permissions). Then click Try Again."))
    }

    // One launcher per WorkShop folder (see LauncherLock). A second one hands over to the first.
    switch LauncherLock.shared.acquire(paths.launcherLock) {
    case .mine: break
    case .other(let pid):
        log("startup: another WorkShop launcher (pid \(pid)) already holds \(paths.launcherLock)")
        if pid > 1, pid != getpid(), pidAlive(pid) {
            let hubPid = readLock(paths.lock).map { pidAlive($0.pid) ? $0.pid : 0 } ?? 0
            return .otherLauncher(pid: pid, hubPid: hubPid)
        }
        return .problem(Problem(kind: "busy", title: "WorkShop is already starting",
            message: "Another copy of WorkShop is starting for this folder right now.\n\nWhat to do: wait a moment, then click Try Again."))
    case .unavailable(let why):
        log("startup: no launcher lock (\(why)); going on without it")
    }

    if let plan = runningHubPlan(paths: paths) { return plan }

    let probe = probeLoginShell(cwd: paths.base)
    log(String(format: "startup: login shell %@ took %.2f s; command -v node=%@; process.execPath=%@; PATH captured=%@ %@",
               probe.shell, probe.seconds, probe.commandV ?? "(none)", probe.execPath ?? "(none)",
               probe.path == nil ? "no" : "yes", probe.note.isEmpty ? "" : "note: " + probe.note))
    let (choice, notes) = chooseNode(probe: probe)
    notes.forEach { log("startup: node candidate rejected: \($0)") }
    guard let node = choice else {
        let folders = nodeLookupFolders.joined(separator: "\n")
        var detail = notes.isEmpty ? "" : "Found, but not usable:\n" + notes.joined(separator: "\n") + "\n\n"
        detail += "Advanced: point WorkShop at a node of your choice with\ndefaults write \(Bundle.main.bundleIdentifier ?? "local.workshop.app") NodePath /full/path/to/node"
        return .problem(Problem(kind: "no-node", title: "WorkShop needs Node.js \(Cfg.minNodeMajor) or newer",
            message: "WorkShop did not find a usable “node”. It asked your login shell (\(probe.shell)\(probe.note.isEmpty ? "" : ": " + probe.note)) and looked in these folders:\n\n\(folders)\n\nWhat to do: install Node.js \(Cfg.minNodeMajor) or newer from https://nodejs.org (or run “brew install node” in Terminal). Then click Try Again.",
            detail: detail))
    }
    return .start(node: node, probe: probe)
}

// MARK: - The hub process

struct HubEnd {
    let status: String          // "exit code 1", "killed by signal 9", or "no ready line"
    let wasReady: Bool
    let tail: [String]          // last lines of the hub's stderr and stdout, redacted
}

@MainActor
final class Hub {
    private(set) var pid: pid_t = 0
    private(set) var ready = false
    private var stdinFD: Int32 = -1
    private var outReader: LineReader?
    private var errReader: LineReader?
    private var exitSource: DispatchSourceProcess?
    private var readyTimer: Timer?
    private var familyTimer: Timer?
    private var stopping = false
    private var generation = 0
    private let output = OutputTail(limit: 60)
    /// Every process seen below the hub while it ran (pid + start time), so the ones it leaves behind
    /// can be found even after they were handed to launchd. Agents run in their own process groups and
    /// sessions, so the hub's process group alone does not reach them.
    private var family: [pid_t: ProcEntry] = [:]

    /// Called once per hub run with the READY URL (it still carries the owner key: do not keep it).
    var onReady: ((URL) -> Void)?
    /// Called when the hub ends and the launcher did not ask for it.
    var onEnd: ((HubEnd) -> Void)?

    var isRunning: Bool { pid > 0 }
    private var tail: [String] { output.lines() }

    /// Adds the hub's current descendants to `family` and forgets the ones that have ended.
    private func refreshFamily() {
        guard pid > 0 else { return }
        let table = processTable()
        var alive = Set<String>()
        for p in table { alive.insert("\(p.pid).\(p.startSec).\(p.startUsec)") }
        family = family.filter { alive.contains("\($0.value.pid).\($0.value.startSec).\($0.value.startUsec)") }
        for d in descendants(of: pid, in: table) { family[d.pid] = d }
    }

    /// SIGKILL to every remembered descendant that still runs (same pid AND same start time).
    private func killFamily(_ why: String) {
        let left = family.values.filter { stillRunning($0) }
        left.forEach { kill($0.pid, SIGKILL) }
        if !left.isEmpty { log("hub: killed leftover descendants \(left.map { $0.pid }.sorted()) (\(why))") }
        family = [:]
    }

    func start(node: NodeChoice, probe: ShellProbe, paths: Paths) throws {
        precondition(pid == 0, "one hub at a time")
        var env = cleanBaseEnv()
        env["PATH"] = buildHubPath(loginPath: probe.path, nodePath: node.path)
        if let lp = probe.path, !lp.isEmpty { env["WORKSHOP_PATH"] = lp }     // the login PATH, for the hub's agent environment
        env["WORKSHOP_LAUNCHER_PID"] = String(getpid())
        for (k, v) in ENV where k.hasPrefix("WORKSHOP_STUB_") { env[k] = v }    // test hooks of the stub hub
        log("hub: node \(node.version) at \(node.path) [\(node.source)]")
        log("hub: starting: \(node.path) \(paths.server)   (working folder \(paths.base), \(env.count) environment names)")
        let sp = try spawn(node.path, [paths.server], env: env, cwd: paths.base, newGroup: true, pipeStdin: true, stderr: .pipe)
        pid = sp.pid
        stdinFD = sp.stdinFD
        ready = false
        stopping = false
        output.reset()
        family = [:]
        generation += 1
        let gen = generation
        log("hub: pid \(sp.pid) (own process group)")
        // Output is handled on the readers' own queues. Only the READY line goes to the main thread, so a
        // hub that prints megabytes cannot freeze the window. Other lines only feed the tail (no redaction
        // per line: the tail is redacted when it is read).
        let output = self.output
        let prefix = Cfg.readyPrefix
        outReader = LineReader(fd: sp.stdoutFD, label: "workshop.hub.stdout") { line in
            if line.hasPrefix(prefix) { onMain { [weak self] in self?.stdoutLine(line, gen) } } else { output.append(line) }
        }
        errReader = LineReader(fd: sp.stderrFD, label: "workshop.hub.stderr") { line in output.append(line) }
        familyTimer = every(1.0) { [weak self] in self?.refreshFamily() }
        after(0.2) { [weak self] in if self?.generation == gen { self?.refreshFamily() } }
        let src = DispatchSource.makeProcessSource(identifier: sp.pid, eventMask: .exit, queue: .global(qos: .userInitiated))
        src.setEventHandler { onMain { [weak self] in self?.exited(gen, tries: 0) } }
        src.resume()
        exitSource = src
        let limit = Cfg.readyTimeout
        readyTimer = after(limit) { [weak self] in
            guard let self, self.generation == gen, self.pid > 0, !self.ready, !self.stopping else { return }
            log("hub: no \(Cfg.readyPrefix.trimmingCharacters(in: .whitespaces)) line within \(Int(limit)) s -> stopping it")
            let lines = self.tail
            self.stop(quick: true)
            self.onEnd?(HubEnd(status: "no ready line within \(Int(limit)) seconds", wasReady: false, tail: lines))
        }
    }

    private func stdoutLine(_ line: String, _ gen: Int) {
        guard gen == generation, line.hasPrefix(Cfg.readyPrefix), !ready else { return }
        let raw = String(line.dropFirst(Cfg.readyPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: raw), comps.scheme == "http", let host = comps.host,
              host == "127.0.0.1" || host == "localhost", let port = comps.port, let url = comps.url else {
            log("hub: ignoring a ready line that is not http://127.0.0.1:<port>")
            return
        }
        // The key is remembered as a hash only, so the redactor can still find the exact value later.
        for frag in [comps.percentEncodedFragment, comps.fragment] {
            for part in (frag ?? "").split(separator: "&") where part.hasPrefix("k=") {
                Redactor.shared.remember(String(part.dropFirst(2)))
            }
        }
        ready = true
        readyTimer?.invalidate()
        log("hub: READY on port \(port) (the owner key in the URL fragment is never logged)")
        onReady?(url)
    }

    private func exited(_ gen: Int, tries: Int) {
        guard gen == generation, pid > 0, !stopping else { return }
        var st: Int32 = 0
        let p = pid
        let r = waitpid(p, &st, WNOHANG)
        if r == 0 && tries < 20 { after(0.05) { self.exited(gen, tries: tries + 1) }; return }
        // Give the readers a moment to drain the last stderr lines.
        after(0.15) {
            guard gen == self.generation, self.pid == p, !self.stopping else { return }
            let status = r == p ? describeWaitStatus(st) : "ended"
            log("hub: pid \(p) ended by itself: \(status)")
            if kill(-p, SIGKILL) == 0 { log("hub: killed leftover members of process group \(p)") }
            self.killFamily("the hub ended by itself; launchd adopted them")
            let lines = self.tail
            let wasReady = self.ready
            self.cleanup()
            for l in lines.suffix(20) { log("hub: last output: \(l)") }
            self.onEnd?(HubEnd(status: status, wasReady: wasReady, tail: lines))
        }
    }

    private func cleanup() {
        readyTimer?.invalidate(); readyTimer = nil
        familyTimer?.invalidate(); familyTimer = nil
        exitSource?.cancel(); exitSource = nil
        outReader?.cancel(); errReader?.cancel()        // closes the pipes, also when a grandchild still holds them open
        outReader = nil; errReader = nil
        if stdinFD >= 0 { close(stdinFD); stdinFD = -1 }
        pid = 0
        ready = false
    }

    /// Stops the hub and makes sure nothing it started survives. Blocks for at most
    /// stdinGrace + termGrace seconds (2 s with quick).
    func stop(quick: Bool = false) {
        guard pid > 0 else { return }
        stopping = true
        let p = pid
        refreshFamily()
        log("hub: stopping pid \(p); descendants now: \(descendants(of: p, in: processTable()).map { $0.pid })")
        if stdinFD >= 0 { close(stdinFD); stdinFD = -1 }       // end-of-file on stdin = "shut down cleanly"
        var st: Int32 = 0
        func waitExit(_ seconds: TimeInterval) -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            var n = 0
            while Date() < deadline {
                let r = waitpid(p, &st, WNOHANG)
                if r == p || (r < 0 && errno == ECHILD) { return true }
                n += 1
                if n % 10 == 0 { refreshFamily() }         // what the hub starts while it shuts down counts too
                usleep(20_000)
            }
            return false
        }
        var how = "after its stdin closed"
        var gone = waitExit(quick ? 1 : Cfg.stdinGrace)
        if !gone {
            log("hub: still running \(quick ? 1 : Int(Cfg.stdinGrace)) s after stdin closed -> SIGTERM")
            kill(p, SIGTERM)
            how = "after SIGTERM"
            gone = waitExit(quick ? 1 : Cfg.termGrace)
        }
        if !gone {
            log("hub: ignored SIGTERM -> SIGKILL")
            kill(p, SIGKILL)
            _ = waitpid(p, &st, 0)
            how = "after SIGKILL"
        }
        log("hub: ended \(how) (\(describeWaitStatus(st)))")
        if kill(-p, SIGKILL) == 0 { log("hub: killed leftover members of process group \(p)") }
        killFamily("the hub did not end them")
        cleanup()
    }
}
