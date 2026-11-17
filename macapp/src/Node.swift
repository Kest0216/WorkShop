// WorkShop launcher: find Node.js and the login PATH.
// An app started from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `node` (nvm, Homebrew, Volta)
// is not on it. The launcher asks the login shell once (with a time limit), then tries known folders.

import Cocoa

struct ShellProbe: Sendable {
    var shell = ""
    var commandV: String?            // what `command -v node` printed
    var execPath: String?            // process.execPath reported by node inside the login shell
    var path: String?                // $PATH of the login shell
    var note = ""
    var seconds = 0.0
}

struct NodeChoice: Sendable { let path: String; let version: String; let source: String }

func userLoginShell() -> String {
    if let o = ENV["WORKSHOP_SHELL"], !o.isEmpty { return o }       // override (also used by tests)
    if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell {
        let s = String(cString: sh)
        if !s.isEmpty { return s }
    }
    return ENV["SHELL"] ?? "/bin/zsh"
}

/// A clean, launchd-like base environment: what a Finder launch gives an app.
/// The hub gets the same environment however the app was started. (`open` from a terminal or from
/// an agent forwards that shell's whole environment, API keys and session variables included.)
func cleanBaseEnv() -> [String: String] {
    var e: [String: String] = [:]
    for k in ["SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "COMMAND_MODE"] {
        if let v = ENV[k] { e[k] = v }
    }
    e["HOME"] = NSHomeDirectory()
    e["USER"] = NSUserName()
    e["LOGNAME"] = NSUserName()
    e["SHELL"] = userLoginShell()
    e["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    var tmp = [CChar](repeating: 0, count: 1024)
    if confstr(_CS_DARWIN_USER_TEMP_DIR, &tmp, tmp.count) > 0 { e["TMPDIR"] = String(cString: tmp) }
    return e
}

/// Runs the user's login shell once (login + interactive, so ~/.zprofile AND ~/.zshrc load, which is
/// where nvm lives) and asks it for node and PATH. Output is fenced by markers, so banners printed by
/// rc files are ignored. Never waits longer than Cfg.shellTimeout and never waits for end-of-file:
/// a background program started by an rc file can hold the pipe open forever.
func probeLoginShell(cwd: String) -> ShellProbe {
    var r = ShellProbe()
    r.shell = userLoginShell()
    let t0 = Date()
    guard isRegularExecutable(r.shell) else { r.note = "shell not executable"; return r }

    let js = #"process.stdout.write("\n__WS_EXEC__"+process.execPath+"\n")"#
    let script = #"printf '\n__WS_BEGIN__\n'; command -v node; printf '\n__WS_PATH__%s\n' "$PATH"; node -e '"# + js
        + #"' 2>/dev/null; printf '\n__WS_END__\n'"#
    // The shell runs under a tiny watchdog: /bin/sh keeps a pipe from the launcher open in a background
    // subshell and then becomes the login shell (exec, same pid, same process group). When the pipe
    // closes (the launcher closes it after the lookup, or the launcher quits or is killed during a slow
    // rc file), the watchdog kills the whole process group. So a launcher that quits during startup
    // leaves no shell, and no rc-file program, behind.
    let watchdog = #"exec 3<&0 </dev/null; ( read -r _ <&3; kill -KILL 0 ) >/dev/null 2>&1 & exec "$@" 3<&-"#
    let p: Spawned
    do {
        p = try spawn("/bin/sh", ["-c", watchdog, "workshop-shell-probe", r.shell, "-l", "-i", "-c", script],
                      env: cleanBaseEnv(), cwd: cwd, newGroup: true, pipeStdin: true, stderr: .null)
    } catch { r.note = "\(error)"; return r }

    // Done at the first end marker AFTER the start marker: an rc file may print anything before it.
    let beginMarker = Data("__WS_BEGIN__".utf8), endMarker = Data("__WS_END__".utf8)
    let res = readUntil(fd: p.stdoutFD, deadline: Date().addingTimeInterval(Cfg.shellTimeout)) { data in
        guard let b = data.range(of: beginMarker) else { return false }
        return data.range(of: endMarker, in: b.upperBound..<data.endIndex) != nil
    }
    close(p.stdoutFD)
    defer { close(p.stdinFD) }                               // the watchdog ends with it
    r.seconds = Date().timeIntervalSince(t0)
    if res.timedOut { r.note = "timed out after \(Int(Cfg.shellTimeout)) s" }
    // Let the shell leave on its own for a moment, then make sure nothing stays behind.
    var st: Int32 = 0
    var gone = false
    for _ in 0..<(res.timedOut ? 0 : 50) {
        if waitpid(p.pid, &st, WNOHANG) != 0 { gone = true; break }
        usleep(10_000)
    }
    if !gone { kill(-p.pid, SIGKILL); kill(p.pid, SIGKILL); reapLater(p.pid) } else { kill(-p.pid, SIGKILL) }

    let text = String(decoding: res.data, as: UTF8.self)
    guard let begin = text.range(of: "__WS_BEGIN__") else {
        if r.note.isEmpty { r.note = "no output from the shell" }
        return r
    }
    for raw in text[begin.upperBound...].split(separator: "\n", omittingEmptySubsequences: true) {
        let line = String(raw).trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("__WS_END__") { break }
        if line.hasPrefix("__WS_PATH__") { r.path = String(line.dropFirst("__WS_PATH__".count)) }
        else if line.hasPrefix("__WS_EXEC__") { r.execPath = String(line.dropFirst("__WS_EXEC__".count)) }
        else if r.commandV == nil && r.path == nil { r.commandV = line }
    }
    return r
}

/// Newest-first list of "<root>/<version>/<suffix>" paths, e.g. ~/.nvm/versions/node/v20.20.2/bin/node.
func versionedInstalls(root: String, suffix: String) -> [String] {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
    func key(_ n: String) -> [Int] {
        n.drop(while: { !$0.isNumber }).split(separator: ".").map { Int($0.prefix(while: { $0.isNumber })) ?? 0 }
    }
    return names.filter { !key($0).isEmpty }
        .sorted { key($1).lexicographicallyPrecedes(key($0)) }
        .map { root + "/" + $0 + suffix }
}

func nodeVersion(at path: String) -> String? {
    guard isRegularExecutable(path) else { return nil }
    guard let p = try? spawn(path, ["--version"], env: ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()], cwd: nil,
                             newGroup: false, pipeStdin: false, stderr: .null) else { return nil }
    let res = readUntil(fd: p.stdoutFD, deadline: Date().addingTimeInterval(5)) { $0.contains(0x0A) }
    close(p.stdoutFD)
    if res.timedOut { kill(p.pid, SIGKILL) }
    reapLater(p.pid)
    let s = String(decoding: res.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return s.hasPrefix("v") ? s : nil
}

/// The folders the launcher looks in, in order, for the error text.
let nodeLookupFolders = ["~/.nvm/versions/node", "~/.volta/bin", "/opt/homebrew/bin", "/usr/local/bin"]

/// Order: WORKSHOP_NODE, `defaults write <bundle id> NodePath`, login shell, newest nvm install,
/// Volta, Homebrew, /usr/local, other version managers, MacPorts. Each candidate must run and be v20+.
func chooseNode(probe: ShellProbe) -> (NodeChoice?, [String]) {
    let home = NSHomeDirectory()
    var cands: [(String, String)] = []
    if let o = ENV["WORKSHOP_NODE"], !o.isEmpty { cands.append((o, "env WORKSHOP_NODE")) }
    if let o = UserDefaults.standard.string(forKey: "NodePath"), !o.isEmpty { cands.append((o, "defaults NodePath")) }
    if ENV["WORKSHOP_TEST_NO_NODE"] != "1" {
        if let p = probe.execPath, p.hasPrefix("/") { cands.append((p, "login shell \(probe.shell) (process.execPath)")) }
        if let p = probe.commandV, p.hasPrefix("/") { cands.append((p, "login shell \(probe.shell) (command -v node)")) }
        for p in versionedInstalls(root: home + "/.nvm/versions/node", suffix: "/bin/node") { cands.append((p, "newest nvm install")) }
        for p in [home + "/.volta/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"] { cands.append((p, "known folder")) }
        // Other version managers (same idea, not exercised on the build machine):
        for (root, suffix) in [(home + "/.volta/tools/image/node", "/bin/node"),
                               (home + "/.local/share/fnm/node-versions", "/installation/bin/node"),
                               (home + "/Library/Application Support/fnm/node-versions", "/installation/bin/node"),
                               (home + "/.asdf/installs/nodejs", "/bin/node"),
                               (home + "/.local/share/mise/installs/node", "/bin/node"),
                               ("/usr/local/n/versions/node", "/bin/node")] {
            for p in versionedInstalls(root: root, suffix: suffix) { cands.append((p, "version manager")) }
        }
        cands.append(("/opt/local/bin/node", "known folder"))
    }
    var notes: [String] = []
    var seen = Set<String>()
    for (path, source) in cands where seen.insert(path).inserted {
        guard let v = nodeVersion(at: path) else {
            if FileManager.default.fileExists(atPath: path) { notes.append("\(path): cannot run it") }
            continue
        }
        let major = Int(v.dropFirst().prefix(while: { $0.isNumber })) ?? 0
        if major < Cfg.minNodeMajor { notes.append("\(path): \(v) is older than v\(Cfg.minNodeMajor)"); continue }
        return (NodeChoice(path: path, version: v, source: source), notes)
    }
    return (nil, notes)
}

/// PATH of the hub process: node's own folder first, then the login PATH, then the usual places.
func buildHubPath(loginPath: String?, nodePath: String) -> String {
    var parts: [String] = []
    func add(_ p: String) { if p.hasPrefix("/") && !parts.contains(p) { parts.append(p) } }
    add((nodePath as NSString).deletingLastPathComponent)
    (loginPath ?? "").split(separator: ":").forEach { add(String($0)) }
    let home = NSHomeDirectory()
    for p in [home + "/.local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] { add(p) }
    return parts.joined(separator: ":")
}
