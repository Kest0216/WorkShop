// WorkShop launcher: the native bridge.
//
//   const reply = await window.webkit.messageHandlers.workshop.postMessage({ type, ... })
//
//   { type: 'notify', title, body }   macOS notification. Permission is asked the first time, not at launch.
//                                      -> { ok: true, shown: boolean }
//   { type: 'badge', count }          Dock badge. 0 clears it.            -> { ok: true }
//   { type: 'pickFolder' }            native folder panel.                -> { ok: true, path: string | null }
//   { type: 'reveal', path }          shows a path in Finder, only inside the WorkShop folder. -> { ok: true }
//   { type: 'quitState', live }       tells the launcher whether a job is live (quit question). -> { ok: true }
//
// Every message is validated. A bad message rejects the promise with a plain reason.
// Messages are accepted only from the main frame of the hub's origin.

import Cocoa
import WebKit
@preconcurrency import UserNotifications

/// A JavaScript number that is a whole number (and not a boolean).
private func wholeNumber(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(), abs(d) < 1e9 else { return nil }
    return Int(d)
}

/// A JavaScript boolean (and not a number).
private func strictBool(_ v: Any?) -> Bool? {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
}

/// Plain text for a notification: no control characters, limited length.
/// Cuts first, then cleans: a page that sends megabytes costs no more than a short text.
private func cleanText(_ v: Any?, max: Int) -> String? {
    guard let s = v as? String else { return nil }
    let head = s.unicodeScalars.prefix(max * 2 + 16)
    let flat = String(String.UnicodeScalarView(head.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }))
    return String(flat.trimmingCharacters(in: .whitespaces).prefix(max))
}

@MainActor
extension AppDelegate: WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, let hubOrigin, origin.protocol == "http",
              origin.host.lowercased() == hubOrigin.host, origin.port == hubOrigin.port else {
            log("bridge: message from outside the hub page refused")
            replyHandler(nil, "not allowed from this page"); return
        }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            replyHandler(nil, "a message is an object with a string 'type'"); return
        }
        func bad(_ why: String) {
            log("bridge: \(type) refused: \(why)")
            selfTest?.note("bridge \(type) refused: \(why)")
            replyHandler(nil, why)
        }
        switch type {
        case "notify":
            guard let title = cleanText(body["title"], max: 120), !title.isEmpty else { bad("notify needs a non-empty string 'title'"); return }
            guard let text = cleanText(body["body"] ?? "", max: 500) else { bad("notify 'body' must be a string"); return }
            guard Date().timeIntervalSince(lastNotify) >= 0.5 else { bad("too many notifications at once"); return }
            lastNotify = Date()
            notify(title: title, body: text) { shown in replyHandler(["ok": true, "shown": shown], nil) }

        case "badge":
            guard let count = wholeNumber(body["count"]), count >= 0, count <= 99_999 else { bad("badge needs a whole number 'count' from 0 to 99999"); return }
            NSApp.dockTile.badgeLabel = count == 0 ? nil : String(count)
            selfTest?.note("bridge badge -> \(NSApp.dockTile.badgeLabel ?? "none")")
            replyHandler(["ok": true], nil)

        case "pickFolder":
            guard !pickingFolder else { bad("a folder panel is already open"); return }
            pickFolder { path in
                let value: Any = path ?? NSNull()
                replyHandler(["ok": true, "path": value], nil)
            }

        case "reveal":
            guard let raw = body["path"] as? String, raw.hasPrefix("/"), raw.utf8.count <= 4096, !raw.contains("\0") else { bad("reveal needs an absolute 'path'"); return }
            // realpath() on both sides: symlinks, "..", /var vs /private/var, and NFC vs NFD names.
            guard let target = resolvedPath(raw) else { bad("that path does not exist"); return }
            guard isInside(target, paths.base) else { bad("reveal only works inside the WorkShop folder"); return }
            selfTest?.note("bridge reveal -> \(target)")
            revealInFinder(target)
            replyHandler(["ok": true], nil)

        case "quitState":
            guard let live = strictBool(body["live"]) else { bad("quitState needs a boolean 'live'"); return }
            if live != pageLive { log("bridge: the page says a job is \(live ? "live" : "not live")") }
            pageLive = live
            replyHandler(["ok": true], nil)

        default:
            bad("unknown message type")
        }
    }

    // MARK: notifications

    /// Raises a macOS notification. Asks for permission the first time one is needed.
    /// `done(shown)`: false when the owner has turned notifications off (the Dock icon bounces instead).
    func notify(title: String, body: String, done: @escaping @MainActor (Bool) -> Void) {
        notifications.append(["title": title, "body": body])
        if notifications.count > 50 { notifications.removeFirst() }
        if let st = selfTest {                                     // tests never touch the system notification settings
            st.note("bridge notify -> “\(title)” / “\(body)” [recorded, no system notification in self-test]")
            done(true); return
        }
        let center = UNUserNotificationCenter.current()
        if !notifyDelegateSet { center.delegate = self; notifyDelegateSet = true }
        let fallback: @MainActor (String) -> Void = { why in
            log("notify: no system notification (\(why)) -> Dock bounce")
            if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
            done(false)
        }
        let deliver: @MainActor () -> Void = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
                onMain { if let error { fallback(error.localizedDescription) } else { done(true) } }
            }
        }
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            onMain {
                switch status {
                case .authorized, .provisional:
                    deliver()
                case .notDetermined:
                    log("notify: asking macOS for the notification permission (first use)")
                    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                        onMain { if granted { deliver() } else { fallback(error?.localizedDescription ?? "the owner said no") } }
                    }
                default:
                    fallback("notifications are turned off for \(Cfg.appName) in System Settings")
                }
            }
        }
    }

    /// A notification that arrives while the window is in front is not shown again as a banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let handler = Box<(UNNotificationPresentationOptions) -> Void>()
        handler.value = completionHandler
        onMain {
            let inFront = NSApp.isActive && self.window.isVisible && self.window.occlusionState.contains(.visible)
            handler.value?(inFront ? [.list] : [.banner, .list, .sound])
        }
    }

    /// A click on a notification brings the window back.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let handler = Box<() -> Void>()
        handler.value = completionHandler
        onMain {
            self.showMainWindow(nil)
            handler.value?()
        }
    }

    // MARK: folder panel

    func pickFolder(_ done: @escaping @MainActor (String?) -> Void) {
        pickingFolder = true
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Choose a folder for \(Cfg.appName)"
        if !window.isVisible { window.makeKeyAndOrderFront(nil) }
        if let st = selfTest {
            // Self-test: show the real panel, close it, and hand over the test folder.
            panel.directoryURL = URL(fileURLWithPath: st.dir)
            panel.beginSheetModal(for: window) { _ in
                self.pickingFolder = false
                st.note("folder-panel closed -> returning \(st.pickedFolder ?? "nothing")")
                done(st.pickedFolder)
            }
            after(0.8) {
                st.note("folder-panel visible=\(panel.isVisible) sheetAttached=\(self.window.attachedSheet === panel)")
                self.window.endSheet(panel, returnCode: .cancel)
            }
            return
        }
        panel.beginSheetModal(for: window) { resp in
            self.pickingFolder = false
            done(resp == .OK ? panel.url?.path : nil)
        }
    }
}
