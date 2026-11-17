// WorkShop launcher: the web view and its delegates.
// Navigation is locked to the hub origin. Everything else is refused; http and https links open in
// the default browser. JavaScript dialogs, file pickers and downloads are handled natively.

import Cocoa
import WebKit

/// WKWebView with a short right-click menu: Cut, Copy, Paste (and Inspect Element with WORKSHOP_DEV=1).
final class ShopWebView: WKWebView {
    static let kept: Set<String> = ["WKMenuItemIdentifierCut", "WKMenuItemIdentifierCopy", "WKMenuItemIdentifierPaste"]
    static let inspect = "WKMenuItemIdentifierInspectElement"

    static func trim(_ menu: NSMenu, dev: Bool) {
        for item in menu.items where !item.isSeparatorItem {
            let id = item.identifier?.rawValue ?? ""
            if !(kept.contains(id) || (dev && id == inspect)) { menu.removeItem(item) }
        }
        var lastWasSeparator = true                                // drops leading, doubled and trailing separators
        for item in menu.items {
            if item.isSeparatorItem && lastWasSeparator { menu.removeItem(item) } else { lastWasSeparator = item.isSeparatorItem }
        }
        if let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        ShopWebView.trim(menu, dev: Cfg.devMode)
    }
}

/// Runs in the page at document start. It adds a style sheet through the CSS object model, which the
/// page's Content-Security-Policy does not block:
///   - canvases are scaled with nearest-neighbour (crisp pixels, no smoothing),
///   - a canvas never shows a text-selection or tap highlight and cannot be dragged as an image,
///   - the page does not rubber-band past its edges.
let pageStyleScript = """
(function () {
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(
      'html, body { overscroll-behavior: none; }' +
      'canvas { image-rendering: pixelated; -webkit-user-select: none; user-select: none;' +
      ' -webkit-user-drag: none; -webkit-tap-highlight-color: transparent; outline: none; }' +
      'canvas::selection { background: transparent; }');
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
  } catch (e) {}
})();
"""

@MainActor
extension AppDelegate: WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {

    func makeWebView(frame: NSRect) -> ShopWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()                          // the UI keeps small preferences in localStorage
        cfg.mediaTypesRequiringUserActionForPlayback = []          // UI sounds may play without a click
        if Cfg.devMode { cfg.preferences.setValue(true, forKey: "developerExtrasEnabled") }   // right-click > Inspect Element
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "workshop")
        cfg.userContentController.addUserScript(WKUserScript(source: pageStyleScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let view = ShopWebView(frame: frame, configuration: cfg)
        view.uiDelegate = self
        view.navigationDelegate = self
        view.allowsMagnification = false                           // no pinch zoom: pixel art stays on the pixel grid
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        view.isInspectable = Cfg.devMode                           // Safari > Develop only with WORKSHOP_DEV=1
        view.underPageBackgroundColor = StatusView.navy
        let zoom = UserDefaults.standard.double(forKey: "PageZoom")
        if zoom >= 0.5 && zoom <= 3.0 { view.pageZoom = zoom }
        return view
    }

    // MARK: links

    func isHub(_ url: URL) -> Bool { hubOrigin?.matches(url) ?? false }

    /// The page address for the log: never with a fragment or a query.
    func plain(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "(url)" }
        c.fragment = nil
        c.query = nil
        return c.string ?? "(url)"
    }

    /// Only http and https leave the app, and only to the default browser.
    func openExternally(_ url: URL, why: String) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else {
            refuse(url, why: why); return
        }
        externalOpens.append(url.absoluteString)
        if let st = selfTest {
            st.note("external-open (\(why)) \(url.absoluteString) [recorded, browser not opened in self-test]")
            return
        }
        log("link: opening in the default browser (\(why)): \(url.absoluteString)")
        NSWorkspace.shared.open(url)
    }

    func refuse(_ url: URL, why: String) {
        let shown = String(url.absoluteString.prefix(200))
        refusedLinks.append(shown)
        log("link: refused (\(why)): \(shown)")
        selfTest?.note("refused (\(why)) \(shown)")
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target=_blank and window.open(): never a second window, always the default browser.
        if let url = navigationAction.request.url { openExternally(url, why: "new-window request") }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let a = NSAlert()
        a.messageText = Cfg.appName
        a.informativeText = message
        a.addButton(withTitle: "OK")
        present(a, kind: "alert") { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = Cfg.appName
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        present(a, kind: "confirm") { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        let a = NSAlert()
        a.messageText = Cfg.appName
        a.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.window.initialFirstResponder = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        present(a, kind: "prompt") { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    /// <input type=file>: without this method a WKWebView on macOS shows no file picker at all.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        if !window.isVisible { window.makeKeyAndOrderFront(nil) }
        if let st = selfTest {
            // Self-test: show the real panel (pointed at the test folder), close it, hand over the sample file.
            panel.directoryURL = URL(fileURLWithPath: st.dir)
            panel.beginSheetModal(for: window) { _ in
                st.note("file-panel closed -> returning \(st.sampleUpload?.lastPathComponent ?? "nothing")")
                completionHandler(st.sampleUpload.map { [$0] })
            }
            after(0.8) {
                st.note("file-panel visible=\(panel.isVisible) sheetAttached=\(self.window.attachedSheet === panel)")
                self.window.endSheet(panel, returnCode: .cancel)
            }
            return
        }
        panel.beginSheetModal(for: window) { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        let ownBlob = scheme == "blob" && hubOrigin.map { url.absoluteString.lowercased().hasPrefix("blob:" + $0.string + "/") } == true

        if navigationAction.shouldPerformDownload {                // <a download>
            if isHub(url) || ownBlob || scheme == "data" { decisionHandler(.download) } else { refuse(url, why: "download from another site"); decisionHandler(.cancel) }
            return
        }
        guard let target = navigationAction.targetFrame else {     // target=_blank / window.open
            openExternally(url, why: "new-window link")
            decisionHandler(.cancel); return
        }
        if target.isMainFrame {
            if isHub(url) { decisionHandler(.allow); return }
            if hubOrigin == nil && url.absoluteString == "about:blank" { decisionHandler(.allow); return }   // the launcher's own blank page
            // The window only ever shows the hub. http(s) goes to the browser, anything else nowhere.
            if scheme == "http" || scheme == "https" { openExternally(url, why: "main-frame navigation away from the hub") }
            else { refuse(url, why: "main-frame navigation away from the hub") }
            decisionHandler(.cancel); return
        }
        // Sub-frames: the hub itself, and documents the page builds in place.
        if isHub(url) || ownBlob || scheme == "about" || scheme == "data" { decisionHandler(.allow); return }
        refuse(url, why: "frame from another site")
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let cd = http.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
            decisionHandler(.download); return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let u = webView.url, isHub(u) else { return }
        pageLoads += 1
        loadFailures = 0
        log("page: loaded \(plain(u)) (load #\(pageLoads))")
        if !statusView.isHidden {
            statusView.hide()
            window.makeFirstResponder(webView)                     // the keyboard goes to the page
        }
        watchForSessionCookie()
        // Safety net: the page removes the key fragment itself, right after it has read it. If a page
        // ever fails to, the launcher removes it, so the key cannot stay in the address or the history.
        after(5) {
            guard let now = self.webView.url, self.isHub(now), (now.fragment ?? "").contains("k=") else { return }
            log("page: the key fragment was still in the address 5 s after the load -> removed")
            self.webView.evaluateJavaScript("history.replaceState(null, '', location.pathname + location.search)") { _, _ in }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == "WebKitErrorDomain" && (ns.code == 102 || ns.code == 204) { return }   // policy change / became a download
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        guard hubOrigin != nil, !shuttingDown else { return }
        loadFailures += 1
        log("page: load failed (\(loadFailures)): \(ns.domain) \(ns.code) \(ns.localizedDescription)")
        if hub.isRunning && loadFailures <= 4 {
            after(0.5 * Double(loadFailures)) { self.goHome() }    // the hub may need a moment: try again quietly
            return
        }
        statusView.show(kind: "hub-unreachable", title: "\(Cfg.appName) cannot reach its hub",
                        message: "The page did not load (\(ns.localizedDescription)).\n\nWhat to do: click Try Again. If that does not help, click Restart Hub.",
                        actions: [StatusView.Action(title: "Try Again") { self.loadFailures = 0; self.showBusy("Loading \(Cfg.appName)…"); self.goHome() },
                                  StatusView.Action(title: "Restart Hub") { self.restartHub() },
                                  StatusView.Action(title: "Quit") { self.quitNow() }])
        showWindowQuietly()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("page: the web content process ended -> loading the page again")
        goHome()
    }

    // MARK: WKDownloadDelegate (files go to ~/Downloads and are shown in Finder)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        var name = (suggestedFilename as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "download" }
        let folder: URL
        if let st = selfTest {
            folder = URL(fileURLWithPath: st.dir + "/downloads", isDirectory: true)
        } else {
            folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory() + "/Downloads", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // WKDownload refuses to overwrite: pick "name 2.ext", "name 3.ext", ...
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var dest = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) && n < 1000 {
            dest = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        downloadTargets[ObjectIdentifier(download)] = dest
        log("download: saving \(dest.lastPathComponent) to \(folder.path)")
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        downloads.append(dest.path)
        log("download: finished \(dest.lastPathComponent)")
        selfTest?.note("download finished \(dest.lastPathComponent)")
        revealInFinder(dest.path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        log("download: failed: \(error.localizedDescription)")
        selfTest?.note("download FAILED \(error.localizedDescription)")
    }
}
