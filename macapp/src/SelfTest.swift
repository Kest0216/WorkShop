// WorkShop launcher: test hooks. Inert unless WORKSHOP_SELFTEST_DIR=<folder> is set.
// They let a script prove UI behaviour without a person and without disturbing the owner:
//   - dialogs are answered after 0.5 s (first button, or the one chosen with the "answer" command),
//   - links to the browser, Finder reveals, opened files and notifications are recorded, not performed,
//   - the file picker returns <folder>/upload-sample.txt, the folder panel returns <folder>/picked-folder,
//   - downloads go to <folder>/downloads,
//   - <folder>/launcher-state.json is rewritten twice a second (never with a secret in it),
//   - commands are read from <folder>/commands, one per line:
//       eval <tag> <js>        runs an async function body in the page; the result goes to selftest.log
//       close-window | show-window | reopen | quit | wake | screens | state | drop-cookies | power-off
//       answer <n>             which button the next dialog gets (0 = leave it open)
//       status-button <n>      presses a button of the status view
//       menu <Menu>|<Item>     runs a menu item the way a click does
//       set-frame x,y,w,h      moves the window
//       context-menu-test      runs the right-click menu filter on a sample menu
//       snapshot <name>        saves a picture of the window content as <name>.png

import Cocoa
import WebKit

@MainActor
final class SelfTest {
    let dir: String
    weak var app: AppDelegate?
    var nextAnswer = 1
    private var dialogs = 0
    private var offset: UInt64 = 0
    private var partial = Data()
    private var timers: [Timer] = []

    init(dir: String, app: AppDelegate) {
        self.dir = dir
        self.app = app
        try? FileManager.default.createDirectory(atPath: dir + "/downloads", withIntermediateDirectories: true)
    }

    var sampleUpload: URL? {
        let p = dir + "/upload-sample.txt"
        return FileManager.default.fileExists(atPath: p) ? URL(fileURLWithPath: p) : nil
    }
    var pickedFolder: String? {
        let p = dir + "/picked-folder"
        return FileManager.default.fileExists(atPath: p) ? p : nil
    }

    func note(_ s: String) {
        let clean = Redactor.shared.redact(s)
        log("selftest: " + clean)
        let line = Data((clean + "\n").utf8)
        if let h = FileHandle(forWritingAtPath: dir + "/selftest.log") {
            h.seekToEndOfFile(); h.write(line); h.closeFile()
        } else {
            FileManager.default.createFile(atPath: dir + "/selftest.log", contents: line)
        }
    }

    func start() {
        timers.append(every(0.2) { [weak self] in self?.poll() })
        timers.append(every(0.5) { [weak self] in self?.writeState(final: false) })
    }

    func writeState(final: Bool) {
        guard let app else { return }
        var obj = app.stateSnapshot()
        obj["final"] = final
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? d.write(to: URL(fileURLWithPath: dir + "/launcher-state.json"), options: .atomic)
        if final { try? d.write(to: URL(fileURLWithPath: dir + "/launcher-state-at-quit.json"), options: .atomic) }
    }

    /// Presses a button of the alert, like a person would.
    func autoAnswer(_ alert: NSAlert, kind: String) {
        dialogs += 1
        let n = dialogs
        let which = nextAnswer
        nextAnswer = 1
        let text = "dialog \(n) (\(kind)): “\(alert.messageText)” / “\(alert.informativeText.prefix(120))”"
        guard which > 0 else { note(text + " -> left open"); return }
        after(0.5) {
            let buttons = alert.buttons
            let b = buttons.indices.contains(which - 1) ? buttons[which - 1] : buttons.first
            self.note(text + " buttons=\(buttons.map { $0.title }) -> pressing “\(b?.title ?? "?")”")
            b?.performClick(nil)
        }
    }

    private func poll() {
        guard let h = FileHandle(forReadingAtPath: dir + "/commands") else { return }
        defer { h.closeFile() }
        h.seek(toFileOffset: offset)
        let d = h.readDataToEndOfFile()
        guard !d.isEmpty else { return }
        offset += UInt64(d.count)
        partial.append(d)
        while let nl = partial.firstIndex(of: 0x0A) {
            let line = String(decoding: partial[partial.startIndex..<nl], as: UTF8.self).trimmingCharacters(in: .whitespaces)
            partial.removeSubrange(partial.startIndex...nl)
            if !line.isEmpty { app?.selfTestCommand(line) }
        }
    }
}

@MainActor
extension AppDelegate {

    /// What the tests read. Never holds the owner key, a cookie value or an environment value.
    func stateSnapshot() -> [String: Any] {
        var menus: [[String: Any]] = []
        for top in NSApp.mainMenu?.items ?? [] {
            // Hidden items are the system's extra key equivalents (Globe-key variants); a person never sees them.
            let items = (top.submenu?.items ?? []).filter { !$0.isSeparatorItem && !$0.isHidden }.map { item -> String in
                var mods = ""
                if !item.keyEquivalent.isEmpty {
                    let m = item.keyEquivalentModifierMask
                    mods = " [" + (m.contains(.control) ? "ctrl-" : "") + (m.contains(.option) ? "opt-" : "") + (m.contains(.shift) ? "shift-" : "")
                        + (m.contains(.command) ? "cmd-" : "") + item.keyEquivalent + "]"
                }
                return item.title + mods
            }
            menus.append(["title": top.submenu?.title ?? top.title, "items": items])
        }
        let url = webView.url
        let bf = webView.backForwardList
        let items = [bf.currentItem].compactMap { $0 } + bf.backList + bf.forwardList
        let history = items.map { $0.url }
        return [
            // initialURL: the address an entry was first loaded with, kept by WebKit in memory only.
            "history": ["items": history.count, "anyFragmentWithKey": history.contains { ($0.fragment ?? "").contains("k=") },
                        "anyInitialURLWithKey": items.contains { ($0.initialURL.fragment ?? "").contains("k=") }],
            "pid": Int(getpid()), "bundle": paths.bundle, "base": paths.base, "bundleId": Bundle.main.bundleIdentifier ?? "",
            "launchPATH": ENV["PATH"] ?? "", "dev": Cfg.devMode, "inspectable": webView.isInspectable,
            "window": ["title": window.title, "visible": window.isVisible, "frame": NSStringFromRect(window.frame),
                       "contentSize": NSStringFromSize(window.contentRect(forFrameRect: window.frame).size),
                       "minContentSize": NSStringFromSize(window.contentMinSize), "miniaturized": window.isMiniaturized,
                       "key": window.isKeyWindow, "sheet": window.attachedSheet != nil, "backingScale": Double(window.backingScaleFactor)],
            "appActive": NSApp.isActive,
            "status": ["visible": !statusView.isHidden, "kind": statusView.kind, "title": statusView.titleText,
                       "message": statusView.messageText, "detail": statusView.detailText, "buttons": statusView.actions.map { $0.title }],
            "hub": ["running": hub.isRunning, "pid": Int(hub.pid), "ready": hub.ready, "port": hubOrigin?.port ?? 0],
            "node": ["path": nodeChoice?.path ?? "", "version": nodeChoice?.version ?? "", "source": nodeChoice?.source ?? "",
                     "loginShell": probe.shell, "loginShellSeconds": probe.seconds, "loginPathCaptured": probe.path != nil, "note": probe.note],
            "page": ["loads": pageLoads, "url": url.map { plain($0) } ?? "", "hasFragment": url?.fragment != nil, "hasQuery": url?.query != nil,
                     "onHub": url.map { isHub($0) } ?? false, "zoom": Double(webView.pageZoom), "live": pageLive, "sessionCookies": ownerCookies.count],
            "dockBadge": NSApp.dockTile.badgeLabel ?? "",
            "externalOpens": externalOpens, "refusedLinks": refusedLinks, "reveals": reveals, "openedFiles": openedFiles,
            "notifications": notifications, "downloads": downloads,
            "handedOverTo": Int(handedOverTo), "quitFlowActive": quitFlowActive, "menus": menus,
        ]
    }

    func selfTestCommand(_ line: String) {
        guard let st = selfTest else { return }
        let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).map(String.init)
        let verb = parts[0]
        let arg = parts.count > 1 ? parts[1] : ""
        if verb != "eval" { st.note("command: \(line)") }
        switch verb {
        case "eval":
            let bits = arg.split(separator: " ", maxSplits: 1).map(String.init)
            guard bits.count == 2 else { st.note("eval needs <tag> <js>"); return }
            let tag = bits[0]
            webView.callAsyncJavaScript(bits[1], arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    let wrapped: [String: Any] = ["v": value]
                    let text = (try? JSONSerialization.data(withJSONObject: wrapped)).map { String(decoding: $0, as: UTF8.self) } ?? "{\"v\":\"(not JSON)\"}"
                    st.note("eval-result \(tag) \(text)")
                case .failure(let error):
                    st.note("eval-result \(tag) ERROR \((error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription)")
                }
            }
        case "close-window": window.performClose(nil)
        case "show-window": showMainWindow(nil)
        case "reopen": _ = applicationShouldHandleReopen(NSApp, hasVisibleWindows: window.isVisible)
        case "quit": NSApp.terminate(nil)                              // what Quit WorkShop (Cmd-Q) does
        case "drop-cookies":                                           // what a restart of the web view's network process does
            let store = webView.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { cookies in
                let mine = cookies.filter { $0.domain == self.hubOrigin?.host }
                var left = mine.count
                if left == 0 { st.note("drop-cookies: none to drop") }
                for c in mine { store.delete(c) { left -= 1; if left == 0 { st.note("drop-cookies: dropped \(mine.count)") } } }
            }
        case "wake": checkPage("wake")
        case "power-off":                                              // what macOS posts before log out / shut down
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willPowerOffNotification, object: NSWorkspace.shared)
        case "screens": screensChanged()
        case "state": st.writeState(final: false)
        case "answer": st.nextAnswer = Int(arg) ?? 1
        case "status-button":
            if !statusView.press(Int(arg) ?? 0) { st.note("status-button: no such button") }
        case "menu":
            let names = arg.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            guard names.count == 2, let top = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == names[0] })?.submenu,
                  let item = top.items.first(where: { $0.title == names[1] }), let action = item.action else { st.note("menu: not found"); return }
            if self.responds(to: action) {                             // one of the launcher's own actions
                guard validateMenuItem(item) else { st.note("menu: \(arg) is disabled"); return }
                st.note("menu: \(arg) sent=\(NSApp.sendAction(action, to: self, from: item))")
            } else {                                                   // a standard action: goes down the responder chain
                window.makeFirstResponder(webView)
                var sent = NSApp.sendAction(action, to: nil, from: item)
                var how = "responder chain"
                if !sent { sent = NSApp.sendAction(action, to: webView, from: item); how = "web view directly (the window is not key)" }
                st.note("menu: \(arg) sent=\(sent) via \(how)")
            }
        case "set-frame":
            let n = arg.split(separator: ",").compactMap { Double($0) }
            if n.count == 4 { window.setFrame(NSRect(x: n[0], y: n[1], width: n[2], height: n[3]), display: true) }
            st.note("frame now \(NSStringFromRect(window.frame))")
        case "context-menu-test":
            let menu = NSMenu()
            for id in ["WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "-", "WKMenuItemIdentifierCut", "WKMenuItemIdentifierCopy",
                       "WKMenuItemIdentifierPaste", "-", "WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierDownloadImage", "(none)",
                       "-", "WKMenuItemIdentifierInspectElement"] {
                if id == "-" { menu.addItem(.separator()); continue }
                let item = NSMenuItem(title: id, action: nil, keyEquivalent: "")
                if id != "(none)" { item.identifier = NSUserInterfaceItemIdentifier(id) }
                menu.addItem(item)
            }
            ShopWebView.trim(menu, dev: Cfg.devMode)
            st.note("context-menu kept: " + menu.items.map { $0.isSeparatorItem ? "-" : $0.title.replacingOccurrences(of: "WKMenuItemIdentifier", with: "") }.joined(separator: " "))
        case "snapshot":
            let file = st.dir + "/" + (arg.isEmpty ? "snapshot" : arg) + ".png"
            func save(_ rep: NSBitmapImageRep?) {
                guard let png = rep?.representation(using: .png, properties: [:]) else { st.note("snapshot FAILED"); return }
                try? png.write(to: URL(fileURLWithPath: file))
                st.note("snapshot saved \(rep!.pixelsWide)x\(rep!.pixelsHigh)")
            }
            if !statusView.isHidden, let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                save(rep)
            } else {
                webView.takeSnapshot(with: nil) { image, _ in save(image?.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0) }) }
            }
        default:
            st.note("unknown command \(verb)")
        }
    }
}
