// WorkShop launcher: shared helpers.
// Configuration, paths, the redactor, the log file, main-thread scheduling, posix_spawn,
// the process table, and a small blocking HTTP client for the launcher's own calls to the hub.

import Cocoa
import CryptoKit

// MARK: - Configuration

let ENV = ProcessInfo.processInfo.environment

enum Cfg {
    static let appName = "WorkShop"
    static let serverRelPath = "server/index.js"
    static let readyPrefix = "WORKSHOP_READY "
    static let minNodeMajor = 20
    static let shellTimeout: TimeInterval = 8          // login-shell lookup
    static let stdinGrace: TimeInterval = 5            // stdin closed -> wait for a clean hub exit
    static let termGrace: TimeInterval = 3             // then SIGTERM -> wait -> SIGKILL
    static let frameAutosaveName = "WorkShopMainWindow"
    static let minContentSize = NSSize(width: 1000, height: 640)
    static let defaultContentSize = NSSize(width: 1280, height: 800)
    /// Contract section 4: a job in one of these states is live.
    static let liveJobStatuses: Set<String> = ["planning", "plan_review", "running", "qa", "delivering"]
    /// Sent by a second launcher instance to the one that owns the hub: "show your window".
    static let showWindowNote = Notification.Name("local.workshop.app.showWindow")
    /// The hub must print WORKSHOP_READY within this time (seconds). Tests shorten it.
    static var readyTimeout: TimeInterval {
        if let s = ENV["WORKSHOP_READY_TIMEOUT"], let v = Double(s), v > 0 { return v }
        return 30
    }
    static var devMode: Bool { ENV["WORKSHOP_DEV"] == "1" }
}

struct Paths: Sendable {
    let bundle: String          // .../WorkShop.app
    let base: String            // folder that holds WorkShop.app, server/, ui/ and data/
    var server: String { base + "/" + Cfg.serverRelPath }
    var data: String { base + "/data" }
    var lock: String { data + "/run/hub.lock" }
    var launcherLock: String { data + "/run/launcher.lock" }
    var log: String { data + "/logs/launcher.log" }
    var readme: String { base + "/README.md" }
    init() {
        bundle = Bundle.main.bundlePath
        if let o = ENV["WORKSHOP_BASE_DIR"], !o.isEmpty {
            base = (o as NSString).standardizingPath
        } else {
            base = (bundle as NSString).deletingLastPathComponent
        }
    }
}

// MARK: - Redactor
// Every log line, every hub output line and every text shown in an error view goes through it.
// The owner key itself is never stored: only its SHA-256, so the exact value can still be found.

final class Redactor: @unchecked Sendable {
    static let shared = Redactor()
    private let lock = NSLock()
    private var digests = Set<Data>()
    private let rules: [(NSRegularExpression, String)]
    private let runs: NSRegularExpression

    private init() {
        func rx(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: []) }
        rules = [
            (rx(#"([#?&;]k=)[^\s&#"'<>]+"#), "$1[redacted]"),                      // the owner key in a URL
            (rx(#"("k"\s*:\s*")[^"]*(")"#), "$1[redacted]$2"),                     // ... or in a JSON body
            (rx(#"(workshop_owner[A-Za-z0-9_]*=)[^;\s"']+"#), "$1[redacted]"),     // the session cookie
            (rx(#"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{8,}"#), "$1[redacted]"),
            (rx(#"sk-[A-Za-z0-9_\-]{16,}"#), "[redacted]"),
            (rx(#"AIza[0-9A-Za-z_\-]{20,}"#), "[redacted]"),
            (rx(#"gh[pousr]_[A-Za-z0-9]{20,}"#), "[redacted]"),
            (rx(#"[0-9a-fA-F]{32,}"#), "[redacted]"),                              // long hex: keys, tokens
        ]
        runs = rx(#"[A-Za-z0-9_\-+/]{16,}"#)
    }

    private func digest(_ s: String) -> Data { Data(SHA256.hash(data: Data(s.utf8))) }

    /// Remember a secret by its hash only. Values shorter than 8 characters are ignored.
    func remember(_ secret: String) {
        guard secret.count >= 8 else { return }
        lock.lock(); digests.insert(digest(secret)); lock.unlock()
    }

    func redact(_ text: String) -> String {
        var s = text
        for (re, template) in rules {
            s = re.stringByReplacingMatches(in: s, options: [], range: NSRange(s.startIndex..., in: s), withTemplate: template)
        }
        lock.lock(); let known = digests; lock.unlock()
        guard !known.isEmpty else { return s }
        let ns = s as NSString
        let hits = runs.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length))
            .filter { known.contains(digest(ns.substring(with: $0.range))) }
        guard !hits.isEmpty else { return s }
        let out = NSMutableString(string: s)
        for m in hits.reversed() { out.replaceCharacters(in: m.range, with: "[redacted]") }
        return out as String
    }
}

// MARK: - Logging (data/logs/launcher.log, mode 0600; every line is redacted)
// The file is opened by makeStartupPlan(), off the main thread, and only when server/index.js exists:
// a launcher in the wrong folder must not leave a data/ folder there. Until then lines wait in memory.

final class Log: @unchecked Sendable {
    static let shared = Log()
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var path = ""
    private var pending: [String] = []
    private var bytes = 0
    private let maxBytes = 2_000_000                 // then launcher.log -> launcher.log.1 (one generation kept)
    private let fmt: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func start(path: String) {
        lock.lock(); defer { lock.unlock() }
        guard fd < 0 else { return }
        self.path = path
        let logs = (path as NSString).deletingLastPathComponent
        let data = (logs as NSString).deletingLastPathComponent
        for dir in [data, logs] where !FileManager.default.fileExists(atPath: dir) { mkdir(dir, 0o700) }
        openFile()
        if fd >= 0 {
            for line in pending { _ = line.withCString { Darwin.write(fd, $0, strlen($0)) }; bytes += line.utf8.count }
            pending.removeAll()
        }
    }

    private func openFile() {
        if fd >= 0 { close(fd); fd = -1 }
        bytes = ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int) ?? 0
        if bytes > maxBytes {
            try? FileManager.default.removeItem(atPath: path + ".1")
            try? FileManager.default.moveItem(atPath: path, toPath: path + ".1")
            bytes = 0
        }
        fd = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o600)
    }

    func write(_ msg: String) {
        let clean = Redactor.shared.redact(msg)
        lock.lock(); defer { lock.unlock() }
        let line = "\(fmt.string(from: Date())) [\(getpid())] \(clean)\n"
        if fd >= 0 {
            _ = line.withCString { Darwin.write(fd, $0, strlen($0)) }
            bytes += line.utf8.count
            if bytes > maxBytes { openFile() }
        } else if pending.count < 500 {
            pending.append(line)
        }
        if Cfg.devMode || ENV["WORKSHOP_SELFTEST_DIR"] != nil { fputs(line, stderr) }
    }
}

func log(_ s: String) { Log.shared.write(s) }

// MARK: - Main-thread scheduling
// Rule: UI work never runs inside a DispatchQueue.main block. A block on that queue that opens a
// sheet or calls NSApp.terminate() spins a nested run loop, and the (serial) main queue then stalls
// until it returns: timers, signal handlers and network replies queued there never arrive.
// These helpers schedule straight on the run loop instead.

func onMain(_ block: @escaping @MainActor () -> Void) {
    RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { block() } }
    CFRunLoopWakeUp(CFRunLoopGetMain())
}

/// One-shot timer on the main run loop (all common modes, so it also fires while a sheet is up).
@MainActor @discardableResult
func after(_ seconds: TimeInterval, _ block: @escaping @MainActor () -> Void) -> Timer {
    let t = Timer(timeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { block() } }
    RunLoop.main.add(t, forMode: .common)
    return t
}

/// Repeating timer on the main run loop, common modes.
@MainActor @discardableResult
func every(_ seconds: TimeInterval, _ block: @escaping @MainActor () -> Void) -> Timer {
    let t = Timer(timeInterval: seconds, repeats: true) { _ in MainActor.assumeIsolated { block() } }
    RunLoop.main.add(t, forMode: .common)
    return t
}

final class Box<T>: @unchecked Sendable { var value: T? }

// MARK: - posix_spawn

enum StderrMode { case null, merge, pipe }
struct Spawned { let pid: pid_t; let stdinFD: Int32; let stdoutFD: Int32; let stderrFD: Int32 }
struct SpawnError: Error, CustomStringConvertible { let description: String }

/// posix_spawn with: only stdin/stdout/stderr inherited (POSIX_SPAWN_CLOEXEC_DEFAULT),
/// default signal handlers, optional own process group, optional stdin pipe.
/// Foundation's Process cannot make the child a process-group leader, so this calls posix_spawn itself.
func spawn(_ exe: String, _ args: [String], env: [String: String], cwd: String?,
           newGroup: Bool, pipeStdin: Bool, stderr: StderrMode) throws -> Spawned {
    var inPipe: [Int32] = [-1, -1], outPipe: [Int32] = [-1, -1], errPipe: [Int32] = [-1, -1]
    func fail(_ what: String) -> SpawnError {
        let e = SpawnError(description: "\(what): \(String(cString: strerror(errno)))")
        for fd in inPipe + outPipe + errPipe where fd >= 0 { close(fd) }
        return e
    }
    if pipeStdin, pipe(&inPipe) != 0 { throw fail("pipe") }
    if pipe(&outPipe) != 0 { throw fail("pipe") }
    if stderr == .pipe, pipe(&errPipe) != 0 { throw fail("pipe") }

    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    defer { posix_spawn_file_actions_destroy(&fa) }
    if pipeStdin {
        posix_spawn_file_actions_adddup2(&fa, inPipe[0], 0)
    } else {
        posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    }
    posix_spawn_file_actions_adddup2(&fa, outPipe[1], 1)
    switch stderr {
    case .merge: posix_spawn_file_actions_adddup2(&fa, outPipe[1], 2)
    case .pipe: posix_spawn_file_actions_adddup2(&fa, errPipe[1], 2)
    case .null: posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0)
    }
    if let cwd { posix_spawn_file_actions_addchdir_np(&fa, cwd) }

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    var flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
    if newGroup {
        flags |= POSIX_SPAWN_SETPGROUP
        posix_spawnattr_setpgroup(&attr, 0)          // child becomes leader of a new process group
    }
    var noSignals = sigset_t(); sigemptyset(&noSignals)
    posix_spawnattr_setsigmask(&attr, &noSignals)
    var allSignals = sigset_t(); sigfillset(&allSignals)
    sigdelset(&allSignals, SIGKILL); sigdelset(&allSignals, SIGSTOP)
    posix_spawnattr_setsigdefault(&attr, &allSignals)
    posix_spawnattr_setflags(&attr, Int16(flags))

    let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + args).map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

    var pid: pid_t = 0
    let rc = posix_spawn(&pid, exe, &fa, &attr, argv, envp)
    for fd in [inPipe[0], outPipe[1], errPipe[1]] where fd >= 0 { close(fd) }
    guard rc == 0 else {
        for fd in [inPipe[1], outPipe[0], errPipe[0]] where fd >= 0 { close(fd) }
        throw SpawnError(description: "cannot start \(exe): \(String(cString: strerror(rc)))")
    }
    for fd in [inPipe[1], outPipe[0], errPipe[0]] where fd >= 0 { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    return Spawned(pid: pid, stdinFD: inPipe[1], stdoutFD: outPipe[0], stderrFD: errPipe[0])
}

/// Reads from fd until `stop` says so, EOF, or the deadline. Never blocks past the deadline.
func readUntil(fd: Int32, deadline: Date, stop: (Data) -> Bool) -> (data: Data, timedOut: Bool) {
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
        let remaining = deadline.timeIntervalSinceNow
        if remaining <= 0 { return (data, true) }
        var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let pr = poll(&pfd, 1, Int32(min(remaining, 0.25) * 1000) + 1)
        if pr < 0 { if errno == EINTR { continue }; return (data, false) }
        if pr == 0 { continue }
        let n = read(fd, &buf, buf.count)
        if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return (data, false) }
        if n == 0 { return (data, false) }
        data.append(buf, count: n)
        if stop(data) { return (data, false) }
    }
}

func reapLater(_ pid: pid_t) {
    DispatchQueue.global(qos: .utility).async { var st: Int32 = 0; _ = waitpid(pid, &st, 0) }
}

func describeWaitStatus(_ st: Int32) -> String {
    let sig = st & 0x7f
    return sig == 0 ? "exit code \((st >> 8) & 0xff)" : "killed by signal \(sig)"
}

func isRegularExecutable(_ path: String) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
        && FileManager.default.isExecutableFile(atPath: path)
}

/// realpath(3), or the path as given when it cannot be resolved, in Unicode composed form (NFC).
/// LaunchServices hands the app a decomposed path (NFD) while a shell or a page types the composed one;
/// the file system treats both as the same name, so comparisons must too.
func canonicalPath(_ path: String) -> String {
    guard let r = realpath(path, nil) else { return path.precomposedStringWithCanonicalMapping }
    defer { free(r) }
    return String(cString: r).precomposedStringWithCanonicalMapping
}

/// realpath(3) in NFC, or nil when the path does not exist (or cannot be resolved).
func resolvedPath(_ path: String) -> String? {
    guard let r = realpath(path, nil) else { return nil }
    defer { free(r) }
    return String(cString: r).precomposedStringWithCanonicalMapping
}

/// True when the existing `path` is `folder` or lies inside it, after symlinks are resolved on both.
func isInside(_ path: String, _ folder: String) -> Bool {
    guard let p = resolvedPath(path), let f = resolvedPath(folder) else { return false }
    return p == f || p.hasPrefix(f.hasSuffix("/") ? f : f + "/")
}

func pidAlive(_ pid: pid_t) -> Bool {
    guard pid > 1 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

/// Reads lines from a pipe. `onLine` runs on a private queue, never on the main thread: a hub that
/// prints megabytes must not freeze the window.
/// Lines longer than `maxLine` bytes are cut to their first `maxLine` bytes (the rest is dropped), so
/// memory stays small however the hub writes. Work per read is linear in the bytes read.
final class LineReader: @unchecked Sendable {
    private let fd: Int32
    private let maxLine: Int
    private var partial: [UInt8] = []                    // start of the current line (at most maxLine bytes)
    private var dropping = false                         // the current line is too long: skip to its end
    private let source: DispatchSourceRead
    private let onLine: @Sendable (String) -> Void

    init(fd: Int32, label: String, maxLine: Int = 4096, onLine: @escaping @Sendable (String) -> Void) {
        self.fd = fd
        self.maxLine = maxLine
        self.onLine = onLine
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: label))
        source.setEventHandler { [weak self] in self?.drain() }
        source.setCancelHandler { close(fd) }
        source.resume()
    }

    private func emit() {
        onLine(String(decoding: partial, as: UTF8.self))
        partial.removeAll(keepingCapacity: true)
    }

    private func take(_ bytes: UnsafeBufferPointer<UInt8>) {
        var start = 0
        while start < bytes.count {
            let rest = UnsafeBufferPointer(rebasing: bytes[start...])
            if let i = rest.firstIndex(of: 0x0A) {
                if !dropping { partial.append(contentsOf: rest[..<i].prefix(maxLine - partial.count)) }
                if dropping { dropping = false; partial.removeAll(keepingCapacity: true) } else { emit() }
                start += i + 1
            } else {
                if !dropping {
                    partial.append(contentsOf: rest.prefix(maxLine - partial.count))
                    if partial.count >= maxLine { emit(); dropping = true }   // long line: keep its head only
                }
                start = bytes.count
            }
        }
    }

    private func drain() {
        var chunk = [UInt8](repeating: 0, count: 65536)
        // At most 64 reads (4 MB) per event: a hub that never stops writing cannot keep this queue forever.
        for _ in 0..<64 {
            let n = read(fd, &chunk, chunk.count)
            if n > 0 { chunk.withUnsafeBufferPointer { take(UnsafeBufferPointer(rebasing: $0[0..<n])) }; continue }
            if n == 0 {
                if !partial.isEmpty && !dropping { emit() }
                source.cancel()
                return
            }
            if errno == EINTR { continue }
            return                                           // EAGAIN: nothing more for now
        }
    }

    func cancel() { source.cancel() }
}

/// The last lines a hub printed (stdout and stderr), for the error view and the log. Thread-safe.
/// Lines are kept as printed and redacted when they are read: redaction runs on at most `limit` lines,
/// never once per line of a chatty hub.
final class OutputTail: @unchecked Sendable {
    private let lock = NSLock()
    private var ring: [String] = []
    private let limit: Int
    init(limit: Int = 60) { self.limit = limit }

    func append(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        ring.append(line)
        if ring.count > limit * 2 { ring.removeFirst(ring.count - limit) }        // amortized: trim in batches
    }
    func reset() { lock.lock(); ring.removeAll(); lock.unlock() }
    /// The last `limit` lines, redacted.
    func lines() -> [String] {
        lock.lock(); let raw = ring.suffix(limit); lock.unlock()
        return raw.map { Redactor.shared.redact(String($0.prefix(2000))) }
    }
}

// MARK: - One launcher per WorkShop folder
// data/run/launcher.lock is held with flock() for the whole life of the launcher. The kernel releases it
// when the launcher ends, however it ends (kill -9 included). It holds the launcher's pid as text.
// LaunchServices already refuses a second instance of the app (LSMultipleInstancesProhibited), but a
// second copy of the binary started some other way would race the first to start a hub: two hubs can
// both pass the hub's own lock check before either has written data/run/hub.lock. This lock closes that.

final class LauncherLock: @unchecked Sendable {
    static let shared = LauncherLock()
    private let lock = NSLock()
    private var fd: Int32 = -1

    enum Result { case mine, other(pid_t), unavailable(String) }

    func acquire(_ path: String) -> Result {
        lock.lock(); defer { lock.unlock() }
        if fd >= 0 { return .mine }
        let dir = (path as NSString).deletingLastPathComponent
        if !FileManager.default.fileExists(atPath: dir) {
            do { try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
            catch { return .unavailable("cannot create \(dir): \(error.localizedDescription)") }
        }
        let f = Darwin.open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard f >= 0 else { return .unavailable("cannot open \(path): \(String(cString: strerror(errno)))") }
        if flock(f, LOCK_EX | LOCK_NB) == 0 {
            _ = ftruncate(f, 0)
            let text = "\(getpid())\n"
            _ = text.withCString { pwrite(f, $0, strlen($0), 0) }
            fd = f                                           // kept open (and locked) until the process ends
            return .mine
        }
        guard errno == EWOULDBLOCK else {
            let why = String(cString: strerror(errno))
            close(f)
            return .unavailable("flock: \(why)")
        }
        // Another launcher holds it. It writes its pid right after it gets the lock: give it a moment.
        var pid: pid_t = 0
        for _ in 0..<20 {
            var buf = [CChar](repeating: 0, count: 32)
            let n = pread(f, &buf, 31, 0)
            if n > 0, let v = Int32(String(cString: buf).trimmingCharacters(in: .whitespacesAndNewlines)), v > 1 { pid = v; break }
            usleep(50_000)
        }
        close(f)
        return .other(pid)
    }
}

// MARK: - Process table (to find and kill leftover descendants, and to find who owns a hub)

struct ProcEntry { let pid: pid_t; let ppid: pid_t; let pgid: pid_t; let startSec: Int; let startUsec: Int32 }

func processTable() -> [ProcEntry] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL]
    var size = 0
    guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }
    let stride = MemoryLayout<kinfo_proc>.stride
    let cap = size / stride + 64
    var buf = [kinfo_proc](repeating: kinfo_proc(), count: cap)
    size = cap * stride
    guard sysctl(&mib, UInt32(mib.count), &buf, &size, nil, 0) == 0 else { return [] }
    return buf.prefix(size / stride).map {
        ProcEntry(pid: $0.kp_proc.p_pid, ppid: $0.kp_eproc.e_ppid, pgid: $0.kp_eproc.e_pgid,
                  startSec: $0.kp_proc.p_un.__p_starttime.tv_sec, startUsec: $0.kp_proc.p_un.__p_starttime.tv_usec)
    }
}

func descendants(of root: pid_t, in table: [ProcEntry]) -> [ProcEntry] {
    var byParent: [pid_t: [ProcEntry]] = [:]
    for p in table { byParent[p.ppid, default: []].append(p) }
    var out: [ProcEntry] = [], queue: [pid_t] = [root], seen: Set<pid_t> = [root]
    while let cur = queue.popLast() {
        for c in byParent[cur] ?? [] where !seen.contains(c.pid) {
            seen.insert(c.pid); out.append(c); queue.append(c.pid)
        }
    }
    return out
}

/// True if the very same process (same pid AND same start time) still runs.
func stillRunning(_ p: ProcEntry) -> Bool {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, p.pid]
    var kp = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&mib, 4, &kp, &size, nil, 0) == 0, size > 0, kp.kp_proc.p_pid == p.pid else { return false }
    if Int32(kp.kp_proc.p_stat) == SZOMB { return false }
    return kp.kp_proc.p_un.__p_starttime.tv_sec == p.startSec && kp.kp_proc.p_un.__p_starttime.tv_usec == p.startUsec
}

/// Full path of the executable of a process, or nil.
func procPath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4096)
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    return n > 0 ? String(cString: buf) : nil
}

/// Command-line arguments of a process of this user (argv[0] included), or nil.
func procArgs(_ pid: pid_t) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return nil }
    var buf = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
    let argc = buf.withUnsafeBytes { $0.load(as: Int32.self) }
    var i = 4
    while i < size && buf[i] != 0 { i += 1 }                 // the executable path
    while i < size && buf[i] == 0 { i += 1 }                 // padding
    var args: [String] = []
    while args.count < Int(argc) && i < size {
        let start = i
        while i < size && buf[i] != 0 { i += 1 }
        args.append(String(decoding: buf[start..<i], as: UTF8.self))
        i += 1
    }
    return args
}

// MARK: - HTTP to the hub (the launcher's own calls; never through a proxy, never with stored cookies)

struct HTTPResult: @unchecked Sendable { let status: Int; let json: Any? }

/// Blocking request. Call it off the main thread. nil = no HTTP answer at all.
func httpCall(_ method: String, _ url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval) -> HTTPResult? {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.connectionProxyDictionary = [:]
    cfg.timeoutIntervalForRequest = timeout
    cfg.httpShouldSetCookies = false
    cfg.httpCookieAcceptPolicy = .never
    cfg.urlCache = nil
    let session = URLSession(configuration: cfg)
    defer { session.invalidateAndCancel() }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = method
    req.httpShouldHandleCookies = false
    for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
    req.httpBody = body
    let box = Box<HTTPResult>()
    let sem = DispatchSemaphore(value: 0)
    let task = session.dataTask(with: req) { data, resp, _ in
        if let http = resp as? HTTPURLResponse {
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            box.value = HTTPResult(status: http.statusCode, json: json)
        }
        sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.5)
    return box.value
}
