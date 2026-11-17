// WorkShop launcher: a small native shell (AppKit + WKWebView) around the local Node.js hub.
// No Electron, no npm, no Xcode project. Build with macapp/build.sh (one swiftc call).
//
// What it does, in order:
//   1. Checks that <folder that holds WorkShop.app>/server/index.js is there and readable.
//   2. Reads data/run/hub.lock. A live hub of another WorkShop instance: bring that instance to the
//      front and leave. A live hub started outside the app: say so (the launcher cannot get its owner key).
//   3. Finds Node.js (login shell with a time limit, then known folders).
//   4. Starts  node <base>/server/index.js  (working folder <base>, stdin = a pipe the launcher holds).
//   5. Reads  WORKSHOP_READY <url>#k=<ownerKey>  from the hub's stdout and loads that URL. The key is
//      never logged, shown, or stored: the page posts it once and removes the fragment.
//   6. Quit: asks when a job is live, pauses it through the hub API if the owner says so, then closes
//      the hub's stdin, waits, and makes sure the hub and everything it started are gone.
//
// Files: Support.swift (helpers), Node.swift (node lookup), Hub.swift (hub process, lock, startup plan),
//        StatusView.swift (native status and error view), Web.swift (web view delegates),
//        Bridge.swift (window.webkit.messageHandlers.workshop), SelfTest.swift (test hooks, inert unless set).

import Cocoa
import WebKit

struct HubOrigin: Equatable {
    let host: String
    let port: Int
    var string: String { "http://\(host):\(port)" }
    func matches(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" && url.host?.lowercased() == host && url.port == port
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    let paths = Paths()
    let hub = Hub()
    var window: NSWindow!
    var webView: ShopWebView!
    var statusView: StatusView!
    var selfTest: SelfTest?

    // The hub this launcher started. The origin and the home URL never hold the owner key.
    var hubOrigin: HubOrigin?
    var hubHome: URL?
    var ownerCookies: [HTTPCookie] = []         // the session cookie of the page, memory only, never logged
    var nodeChoice: NodeChoice?
    var probe = ShellProbe()

    var startupRunning = false
    var shuttingDown = false
    var quitConfirmed = false
    var quitFlowActive = false
    var poweringOff = false                     // log out / restart / shut down in progress
    var handedOverTo: pid_t = 0
    var pageLive = false                        // bridge message quitState { live }
    var pageLoads = 0
    var loadFailures = 0
    var cookieTimer: Timer?
    var signalSources: [DispatchSourceSignal] = []
    var activity: NSObjectProtocol?

    // Bridge and web view bookkeeping (see Web.swift and Bridge.swift).
    var externalOpens: [String] = []
    var refusedLinks: [String] = []
    var reveals: [String] = []
    var openedFiles: [String] = []
    var notifications: [[String: String]] = []
    var downloads: [String] = []
    var downloadTargets: [ObjectIdentifier: URL] = [:]
    var pickingFolder = false
    var lastNotify = Date.distantPast
    var notifyDelegateSet = false

    static let zoomLevels: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("launch: \(Cfg.appName) pid=\(getpid()) bundle=\(paths.bundle) base=\(paths.base) macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        log("launch: PATH=\(ENV["PATH"] ?? "(unset)") dev=\(Cfg.devMode)")
        if let d = ENV["WORKSHOP_SELFTEST_DIR"], !d.isEmpty { selfTest = SelfTest(dir: d, app: self) }
        installSignalHandlers()
        buildMenu()
        buildWindow()
        installObservers()
        // No App Nap: the hub and the agents must keep full speed while the window is hidden.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                         reason: "The WorkShop hub and its agents are running")
        // No NSApp.activate() here: a Finder launch is activated by macOS anyway, and `open -g`
        // (a background launch) must stay in the background.
        selfTest?.start()
        startup()
    }

    func installSignalHandlers() {
        signal(SIGPIPE, SIG_IGN)
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                onMain {
                    // A signal means "quit now": no question, and no waiting for an open dialog.
                    log("signal \(sig) received -> quitting")
                    guard let self else { exit(0) }
                    self.quitConfirmed = true
                    after(1.0) {                                   // only reached if AppKit refused to terminate
                        log("signal: terminate() did not finish (dialog open?) -> stopping the hub and exiting directly")
                        self.shuttingDown = true
                        self.selfTest?.writeState(final: true)
                        self.hub.stop()
                        exit(0)
                    }
                    if let sheet = self.window.attachedSheet { self.window.endSheet(sheet, returnCode: .abort) }
                    if self.quitFlowActive {
                        self.quitFlowActive = false
                        NSApp.reply(toApplicationShouldTerminate: true)
                    } else {
                        NSApp.terminate(nil)
                    }
                }
            }
            src.resume()
            signalSources.append(src)
        }
    }

    func installObservers() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { [weak self] _ in
            onMain { log("power: the Mac woke up"); after(1.5) { self?.checkPage("wake") } }
        }
        // Log out, restart or shut down: macOS asks every app to quit. Nobody is there to answer a question,
        // so a live job is paused without asking (see applicationShouldTerminate).
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: nil) { [weak self] _ in
            onMain { log("power: the Mac is logging out, restarting or shutting down"); self?.poweringOff = true }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: nil) { [weak self] _ in
            onMain { self?.screensChanged() }
        }
        // A second WorkShop for the same folder asks this one to come to the front.
        // Paths are compared after realpath(): LaunchServices may hand one instance /private/var/... and
        // another /var/... for the same folder.
        let base = paths.base
        DistributedNotificationCenter.default().addObserver(forName: Cfg.showWindowNote, object: nil, queue: nil) { [weak self] note in
            let target = note.object as? String
            onMain {
                guard let target, canonicalPath(target) == canonicalPath(base), let self, !self.shuttingDown,
                      self.handedOverTo == 0 else { return }               // not the instance that is handing over
                log("app: another WorkShop was opened for this folder -> showing this window")
                self.showMainWindow(nil)
            }
        }
    }

    // MARK: window + menu

    func buildWindow() {
        let size = Cfg.defaultContentSize
        webView = makeWebView(frame: NSRect(origin: .zero, size: size))
        statusView = StatusView(frame: NSRect(origin: .zero, size: size))
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        for v in [webView as NSView, statusView as NSView] {
            v.frame = container.bounds
            v.autoresizingMask = [.width, .height]
            container.addSubview(v)                                // the status view sits on top
        }

        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = Cfg.appName                                 // fixed: never the page title, never a URL
        window.contentMinSize = Cfg.minContentSize
        window.isReleasedWhenClosed = false                        // closing only hides; the app and the hub keep running
        window.collectionBehavior = [.fullScreenPrimary]
        window.tabbingMode = .disallowed
        window.backgroundColor = StatusView.navy
        window.contentView = container
        window.delegate = self
        window.center()
        let restored = window.setFrameUsingName(Cfg.frameAutosaveName)   // the remembered frame
        window.setFrameAutosaveName(Cfg.frameAutosaveName)               // and keep saving it
        keepWindowUsable()
        log("window: frame \(NSStringFromRect(window.frame)) restoredFromDefaults=\(restored)")
        window.makeKeyAndOrderFront(nil)
    }

    /// The frame is never smaller than the minimum and never fully off every screen.
    func keepWindowUsable() {
        var f = window.frame
        let minFrame = window.frameRect(forContentRect: NSRect(origin: .zero, size: Cfg.minContentSize)).size
        f.size.width = max(f.size.width, minFrame.width)
        f.size.height = max(f.size.height, minFrame.height)
        if f != window.frame { window.setFrame(f, display: true) }
        if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) { window.center() }
    }

    func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        @discardableResult
        func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            return item
        }

        let appMenu = submenu(Cfg.appName)
        add(appMenu, "About \(Cfg.appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        appMenu.addItem(.separator())
        add(appMenu, "Hide \(Cfg.appName)", #selector(NSApplication.hide(_:)), "h")
        add(appMenu, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(appMenu, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        appMenu.addItem(.separator())
        add(appMenu, "Quit \(Cfg.appName)", #selector(NSApplication.terminate(_:)), "q")

        // Without this menu, Cmd-C / Cmd-V / Cmd-X / Cmd-A / Cmd-Z do nothing in a web text field.
        let edit = submenu("Edit")
        add(edit, "Undo", Selector(("undo:")), "z")
        add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Delete", #selector(NSText.delete(_:)))
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")

        let view = submenu("View")
        add(view, "Reload", #selector(reloadPage(_:)), "r")
        view.addItem(.separator())
        add(view, "Actual Size", #selector(zoomReset(_:)), "0")
        add(view, "Zoom In", #selector(zoomIn(_:)), "+")
        add(view, "Zoom Out", #selector(zoomOut(_:)), "-")
        view.addItem(.separator())
        add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])

        let win = submenu("Window")
        add(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(win, "Zoom", #selector(NSWindow.performZoom(_:)))
        add(win, "Close", #selector(NSWindow.performClose(_:)), "w")
        win.addItem(.separator())
        add(win, "Show \(Cfg.appName) Window", #selector(showMainWindow(_:)), "1")
        add(win, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        NSApp.windowsMenu = win

        let help = submenu("Help")
        add(help, "\(Cfg.appName) Help", #selector(openReadme(_:)), "?")
        add(help, "Show Launcher Log", #selector(showLog(_:)))
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(openReadme(_:)) { return FileManager.default.fileExists(atPath: paths.readme) }
        if item.action == #selector(showLog(_:)) { return FileManager.default.fileExists(atPath: paths.log) }
        return true
    }

    @objc func reloadPage(_ sender: Any?) {
        if !statusView.isHidden {                                  // an error view is up: Cmd-R = its first button (Try Again / Restart)
            if statusView.kind != "starting" { statusView.press(1) }
            return
        }
        guard let origin = hubOrigin, hubHome != nil else { NSSound.beep(); return }
        if let u = webView.url, origin.matches(u) {
            restoreCookies { self.webView.reload() }
        } else {
            goHome()
        }
    }

    func setZoom(_ z: Double) {
        webView.pageZoom = z
        UserDefaults.standard.set(z, forKey: "PageZoom")
    }
    @objc func zoomReset(_ sender: Any?) { setZoom(1.0) }
    @objc func zoomIn(_ sender: Any?) {
        setZoom(AppDelegate.zoomLevels.first(where: { $0 > Double(webView.pageZoom) + 0.001 }) ?? AppDelegate.zoomLevels.last!)
    }
    @objc func zoomOut(_ sender: Any?) {
        setZoom(AppDelegate.zoomLevels.last(where: { $0 < Double(webView.pageZoom) - 0.001 }) ?? AppDelegate.zoomLevels.first!)
    }

    @objc func openReadme(_ sender: Any?) { openFile(paths.readme) }
    @objc func showLog(_ sender: Any?) { revealInFinder(paths.log) }
    @objc func showMainWindow(_ sender: Any?) {
        window.makeKeyAndOrderFront(nil)
        activateApp()
    }

    /// Brings the app to the front. In self-test mode it only records it: tests run on the owner's
    /// screen and must not take the focus away from what the owner is doing.
    func activateApp() {
        if let st = selfTest { st.note("activate [recorded, focus not taken in self-test]"); return }
        NSApp.activate()
    }

    /// Opens a file in its default app. Recorded, not opened, in self-test mode.
    func openFile(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else { NSSound.beep(); return }
        openedFiles.append(path)
        if let st = selfTest { st.note("open-file \(path) [recorded, not opened in self-test]"); return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    /// Shows a path in Finder. Recorded, not shown, in self-test mode.
    func revealInFinder(_ path: String) {
        reveals.append(path)
        if let st = selfTest { st.note("reveal \(path) [recorded, Finder not opened in self-test]"); return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        log("app: reopen request (Dock click or opened again), hasVisibleWindows=\(flag)")
        if !flag || window.isMiniaturized { window.makeKeyAndOrderFront(nil) }     // brings the closed window back
        return true
    }
    func windowWillClose(_ notification: Notification) {
        if !shuttingDown { log("window: closed; the app and the hub keep running (Dock icon or Window menu brings it back)") }
    }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: startup

    func showBusy(_ text: String) {
        statusView.show(kind: "starting", title: text, message: "", busy: true)
    }

    func startup() {
        guard !startupRunning, !hub.isRunning, !shuttingDown else { return }
        startupRunning = true
        showBusy("Starting \(Cfg.appName)…")
        let paths = self.paths
        DispatchQueue.global(qos: .userInitiated).async {
            let plan = makeStartupPlan(paths: paths)
            onMain {
                self.startupRunning = false
                if !self.shuttingDown { self.run(plan) }
            }
        }
    }

    func quitNow() {
        quitConfirmed = true
        NSApp.terminate(nil)
    }

    func run(_ plan: StartupPlan) {
        let retry = StatusView.Action(title: "Try Again") { self.startup() }
        let quit = StatusView.Action(title: "Quit") { self.quitNow() }
        switch plan {
        case .start(let node, let probe):
            startHub(node: node, probe: probe)

        case .problem(let p):
            log("startup: \(p.kind): \(p.title) | \(p.message.replacingOccurrences(of: "\n", with: " ⏎ "))")
            var actions: [StatusView.Action]
            switch p.kind {
            case "translocated": actions = [quit]
            case "no-server", "read-only": actions = [retry, StatusView.Action(title: "Show Folder") { self.revealInFinder(self.paths.base) }, quit]
            case "no-node": actions = [retry, StatusView.Action(title: "Open nodejs.org") { self.openExternally(URL(string: "https://nodejs.org/")!, why: "install hint") }, quit]
            default: actions = [retry, quit]
            }
            statusView.show(kind: p.kind, title: p.title, message: p.message, detail: p.detail, actions: actions)
            showWindowQuietly()

        case .otherLauncher(let pid, let hubPid):
            // The owner key lives in that instance. Do not open a second window, do not start a second hub.
            log(hubPid > 0
                ? "startup: another \(Cfg.appName) (pid \(pid)) already runs the hub (pid \(hubPid)) of this folder -> bringing it to the front and leaving"
                : "startup: another \(Cfg.appName) (pid \(pid)) is already open for this folder (its hub is not up yet) -> bringing it to the front and leaving")
            handedOverTo = pid
            window.orderOut(nil)
            DistributedNotificationCenter.default().postNotificationName(Cfg.showWindowNote, object: paths.base, userInfo: nil, deliverImmediately: true)
            if let st = selfTest { st.note("activate other instance \(pid) [recorded, focus not taken in self-test]") }
            else { NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows]) }
            after(0.4) { self.quitNow() }

        case .hubElsewhere(let lock, let isHub):
            log("startup: a hub (pid \(lock.pid), port \(lock.port)) already runs for this folder, started outside the app")
            var actions = [retry]
            if isHub { actions.append(StatusView.Action(title: "Stop It and Start Here") { self.stopForeignHub(lock) }) }
            actions.append(quit)
            statusView.show(kind: "hub-elsewhere", title: "\(Cfg.appName) is already running for this folder",
                message: "A \(Cfg.appName) hub already runs for this folder (process \(lock.pid)\(lock.port > 0 ? ", port \(lock.port)" : "")). It was started outside the app, for example with “npm start” in Terminal.\n\nThe app cannot join it: the owner key lives only in that hub and in the link it printed.\n\nWhat to do: stop that hub (press Control-C in its Terminal window). Then click Try Again.",
                actions: actions)
            showWindowQuietly()
        }
    }

    /// Makes the window visible without stealing the focus from another app.
    func showWindowQuietly() {
        if !window.isVisible { window.orderFront(nil) }
    }

    /// "Stop It and Start Here": ends a hub that was started outside the app, after checking again what the pid is.
    func stopForeignHub(_ lock: LockInfo) {
        guard looksLikeHub(lock.pid), launcherOwner(of: lock.pid) == nil else { startup(); return }
        log("startup: the owner asked to stop the hub that was started outside the app (pid \(lock.pid)) -> SIGTERM")
        showBusy("Stopping the other hub…")
        kill(lock.pid, SIGTERM)
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<100 where pidAlive(lock.pid) { usleep(100_000) }
            onMain { self.startup() }
        }
    }

    func startHub(node: NodeChoice, probe: ShellProbe) {
        nodeChoice = node
        self.probe = probe
        hub.onReady = { [weak self] url in self?.hubReady(url) }
        hub.onEnd = { [weak self] end in self?.hubEnded(end) }
        showBusy("Starting \(Cfg.appName)…")
        do {
            try hub.start(node: node, probe: probe, paths: paths)
        } catch {
            run(.problem(Problem(kind: "spawn-failed", title: "The \(Cfg.appName) hub could not be started",
                                 message: "\(error)\n\nWhat to do: click Try Again. If it keeps failing, look at the launcher log (Help > Show Launcher Log).")))
        }
    }

    /// The hub printed its READY line. `url` carries the owner key in its fragment: it goes straight
    /// to the web view and is not kept anywhere else.
    func hubReady(_ url: URL) {
        guard let host = url.host?.lowercased(), let port = url.port,
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        comps.fragment = nil
        hubOrigin = HubOrigin(host: host, port: port)
        hubHome = comps.url
        ownerCookies = []
        pageLive = false
        loadFailures = 0
        webView.load(URLRequest(url: url))
    }

    func hubEnded(_ end: HubEnd) {
        guard !shuttingDown else { return }
        hubOrigin = nil
        hubHome = nil
        ownerCookies = []
        pageLive = false
        cookieTimer?.invalidate()
        NSApp.dockTile.badgeLabel = nil
        webView.loadHTMLString("", baseURL: nil)                   // the old page must not keep talking to a dead port
        if !end.wasReady {
            // A hub that leaves before READY may have found another hub on this data folder (contract 3b).
            let paths = self.paths
            DispatchQueue.global(qos: .userInitiated).async {
                let plan = runningHubPlan(paths: paths)
                onMain { if let plan { self.run(plan) } else { self.showHubStopped(end) } }
            }
            return
        }
        showHubStopped(end)
    }

    func showHubStopped(_ end: HubEnd) {
        let tail = end.tail.joined(separator: "\n")
        let lead = end.wasReady
            ? "The hub ended unexpectedly (\(end.status)). Your work is saved on disk, and agent sessions resume after a restart."
            : "The hub did not start (\(end.status))."
        statusView.show(kind: "hub-stopped", title: "The \(Cfg.appName) hub stopped",
                        message: lead + (tail.isEmpty ? "\n\nThe hub printed nothing before it stopped." : "\n\nLast lines from the hub:"),
                        detail: tail.isEmpty ? nil : tail,
                        actions: [StatusView.Action(title: "Restart") { self.startup() },
                                  StatusView.Action(title: "Show Log") { self.revealInFinder(self.paths.log) },
                                  StatusView.Action(title: "Quit") { self.quitNow() }])
        showWindowQuietly()
        if !NSApp.isActive { NSApp.requestUserAttention(.criticalRequest) }
    }

    func restartHub() {
        showBusy("Restarting \(Cfg.appName)…")
        hubOrigin = nil
        hubHome = nil
        ownerCookies = []
        webView.loadHTMLString("", baseURL: nil)
        hub.stop()
        startup()
    }

    // MARK: the page and its session

    /// Cookies of the hub host in the web view's store (the owner session), or what was seen last.
    func currentCookies(_ done: @escaping @MainActor ([HTTPCookie]) -> Void) {
        guard let origin = hubOrigin else { done([]); return }
        let answered = Box<Bool>()
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            onMain {
                guard answered.value == nil else { return }
                answered.value = true
                let mine = cookies.filter { $0.domain == origin.host }
                if !mine.isEmpty { self.ownerCookies = mine }
                done(mine.isEmpty ? self.ownerCookies : mine)
            }
        }
        after(1.5) {
            guard answered.value == nil else { return }
            answered.value = true
            done(self.ownerCookies)
        }
    }

    /// After a page load: remember the session cookie as soon as the page has it.
    func watchForSessionCookie() {
        cookieTimer?.invalidate()
        var tries = 0
        cookieTimer = every(0.5) {
            tries += 1
            self.currentCookies { cookies in
                if !cookies.isEmpty || tries >= 40 { self.cookieTimer?.invalidate(); self.cookieTimer = nil }
            }
        }
    }

    /// Puts the remembered session cookie back if the web view lost it (its network process restarted).
    func restoreCookies(_ then: @escaping @MainActor () -> Void) {
        guard let origin = hubOrigin else { then(); return }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let saved = ownerCookies
        store.getAllCookies { cookies in
            onMain {
                let have = cookies.contains { $0.domain == origin.host }
                guard !have, !saved.isEmpty else { then(); return }
                log("page: the web view lost its session cookie -> putting it back")
                var left = saved.count
                for c in saved { store.setCookie(c) { onMain { left -= 1; if left == 0 { then() } } } }
            }
        }
    }

    func goHome() {
        guard let home = hubHome else { return }
        restoreCookies { self.webView.load(URLRequest(url: home)) }
    }

    /// After a wake or a display change: a blank or dead page is reloaded; a live page gets a
    /// "workshop:resume" event so it can resync at once.
    func checkPage(_ reason: String) {
        guard let origin = hubOrigin, hub.isRunning, statusView.isHidden, !shuttingDown else { return }
        guard let u = webView.url, origin.matches(u) else {
            log("page: not on the hub after \(reason) -> loading it again")
            goHome(); return
        }
        let answered = Box<Bool>()
        let js = "(function(){try{window.dispatchEvent(new Event('workshop:resume'))}catch(e){}return document.body?document.body.childElementCount:-1})()"
        webView.evaluateJavaScript(js) { result, error in
            guard answered.value == nil else { return }
            answered.value = true
            let n = (result as? NSNumber)?.intValue ?? -1
            if error != nil || n <= 0 {
                log("page: blank after \(reason) -> loading it again")
                self.goHome()
            } else {
                log("page: alive after \(reason)")
            }
        }
        after(3) {
            guard answered.value == nil else { return }
            answered.value = true
            log("page: no answer after \(reason) -> loading it again")
            self.goHome()
        }
    }

    func screensChanged() {
        log("display: the screen setup changed (\(NSScreen.screens.count) screen(s))")
        keepWindowUsable()
        webView.needsDisplay = true
        after(0.5) { self.checkPage("a display change") }
    }

    // MARK: quit

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitConfirmed || !hub.isRunning { return .terminateNow }
        guard let origin = hubOrigin else { return .terminateNow }      // still starting: nothing to ask yet
        if quitFlowActive { return .terminateCancel }
        quitFlowActive = true
        if poweringOff {
            // No question at log out: a sheet would only stall it ("WorkShop interrupted log out").
            // Live jobs are paused through the hub (as "Pause and quit" does), then the hub stops.
            currentCookies { cookies in
                DispatchQueue.global(qos: .userInitiated).async {
                    let ids = liveJobIds(origin: origin, cookies: cookies) ?? []
                    let failures = ids.isEmpty ? [] : pauseJobs(origin: origin, cookies: cookies, ids: ids)
                    onMain {
                        log("quit: log out / shut down: live jobs \(ids) paused\(failures.isEmpty ? "" : "; failures: " + failures.joined(separator: " | ")) -> quitting without a question")
                        self.finishQuit(true)
                    }
                }
            }
            return .terminateLater
        }
        currentCookies { cookies in
            DispatchQueue.global(qos: .userInitiated).async {
                let ids = liveJobIds(origin: origin, cookies: cookies)
                onMain { self.quitDecision(origin, cookies, ids) }
            }
        }
        return .terminateLater
    }

    func finishQuit(_ quit: Bool) {
        guard quitFlowActive else { return }
        quitFlowActive = false
        if quit { quitConfirmed = true }
        NSApp.reply(toApplicationShouldTerminate: quit)
    }

    /// ids = the live jobs the hub reported, or nil when the hub could not be asked.
    func quitDecision(_ origin: HubOrigin, _ cookies: [HTTPCookie], _ ids: [String]?) {
        guard quitFlowActive else { return }
        let live = ids.map { !$0.isEmpty } ?? pageLive
        log("quit: live job: \(live ? "yes" : "no") (hub says \(ids.map { "\($0)" } ?? "nothing"), page says \(pageLive))")
        guard live else { finishQuit(true); return }
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "A job is still working"
        a.informativeText = "Keep working leaves \(Cfg.appName) open and the job running.\n\nPause and quit pauses the job first. It goes on from where it stopped when you resume it."
        a.addButton(withTitle: "Keep working")
        a.addButton(withTitle: "Pause and quit")
        present(a, kind: "quit-live") { resp in
            guard self.quitFlowActive else { return }
            guard resp == .alertSecondButtonReturn else {
                log("quit: the owner chose Keep working")
                self.finishQuit(false); return
            }
            log("quit: the owner chose Pause and quit")
            guard let ids, !ids.isEmpty else {
                self.askQuitAnyway("The hub did not answer, so the job could not be paused.")
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let failures = pauseJobs(origin: origin, cookies: cookies, ids: ids)
                onMain {
                    if failures.isEmpty { self.finishQuit(true) } else { self.askQuitAnyway(failures.joined(separator: "\n")) }
                }
            }
        }
    }

    func askQuitAnyway(_ why: String) {
        guard quitFlowActive else { return }
        log("quit: pause failed: \(why.replacingOccurrences(of: "\n", with: " | "))")
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "The job could not be paused"
        a.informativeText = why + "\n\nQuit anyway stops the hub now. The hub pauses the job as it stops, if it still can. Resume it after the next start."
        a.addButton(withTitle: "Keep working")
        a.addButton(withTitle: "Quit anyway")
        present(a, kind: "quit-pause-failed") { resp in self.finishQuit(resp == .alertSecondButtonReturn) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        cookieTimer?.invalidate()
        window.orderOut(nil)
        selfTest?.writeState(final: true)
        hub.stop()
        log("quit: done")
    }

    // MARK: alerts (sheets on the main window)

    func present(_ alert: NSAlert, kind: String, done: @escaping @MainActor (NSApplication.ModalResponse) -> Void) {
        selfTest?.autoAnswer(alert, kind: kind)
        if !window.isVisible { window.makeKeyAndOrderFront(nil) }
        if window.attachedSheet == nil {
            alert.beginSheetModal(for: window) { resp in done(resp) }
        } else {
            onMain { done(alert.runModal()) }                      // a sheet is already up: app-modal instead
        }
    }
}

// MARK: - The launcher's own calls to the hub (owner session = the page's cookie)

func cookieHeader(_ cookies: [HTTPCookie]) -> String {
    cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
}

/// GET /api/state -> ids of the jobs in a live state. nil when the hub gave no usable answer.
func liveJobIds(origin: HubOrigin, cookies: [HTTPCookie]) -> [String]? {
    guard !cookies.isEmpty, let url = URL(string: origin.string + "/api/state") else { return nil }
    guard let r = httpCall("GET", url, headers: ["Cookie": cookieHeader(cookies), "Accept": "application/json"], timeout: 2.0),
          r.status == 200, let top = r.json as? [String: Any], let state = top["state"] as? [String: Any] else { return nil }
    let jobs = (state["jobs"] as? [String: Any]) ?? [:]
    var ids: [String] = []
    for (key, value) in jobs {
        guard let job = value as? [String: Any], let status = job["status"] as? String, Cfg.liveJobStatuses.contains(status) else { continue }
        ids.append((job["id"] as? String) ?? key)
    }
    return ids.sorted()
}

/// POST /api/jobs/:id/pause { hard: true } for each id. Returns one line per failure.
func pauseJobs(origin: HubOrigin, cookies: [HTTPCookie], ids: [String]) -> [String] {
    var failures: [String] = []
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    for id in ids {
        guard let enc = id.addingPercentEncoding(withAllowedCharacters: allowed),
              let url = URL(string: origin.string + "/api/jobs/\(enc)/pause") else { failures.append("\(id): bad job id"); continue }
        let r = httpCall("POST", url,
                         headers: ["Cookie": cookieHeader(cookies), "X-WorkShop": "1", "Content-Type": "application/json", "Accept": "application/json"],
                         body: Data(#"{"hard":true}"#.utf8), timeout: 8.0)
        if let r, (200..<300).contains(r.status) {
            log("quit: paused job \(id)")
        } else {
            let msg = ((r?.json as? [String: Any])?["error"] as? String) ?? (r.map { "the hub answered \($0.status)" } ?? "the hub did not answer")
            failures.append("\(id): \(msg)")
        }
    }
    return failures
}

// MARK: - main

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()                                  // never returns, so the delegate stays alive
}
