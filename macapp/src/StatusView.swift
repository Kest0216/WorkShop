// WorkShop launcher: the native status view.
// It covers the web view while the hub starts and whenever something is wrong (no Node.js, no server
// folder, the hub stopped). It is plain AppKit, not a web page: it works without a hub, it cannot be
// reached by page script, and it never blocks the run loop the way a modal alert does.

import Cocoa

@MainActor
final class StatusView: NSView {
    struct Action {
        let title: String
        let handler: @MainActor () -> Void
    }

    private(set) var kind = ""
    private(set) var titleText = ""
    private(set) var messageText = ""
    private(set) var detailText = ""
    private(set) var actions: [Action] = []

    private let icon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    private let detailScroll = NSScrollView()
    private let detailView = NSTextView()
    private let buttonRow = NSStackView()
    private let spinner = NSProgressIndicator()
    private let column = NSStackView()

    static let navy = NSColor(srgbRed: 0.078, green: 0.098, blue: 0.172, alpha: 1)
    static let ink = NSColor(srgbRed: 0.047, green: 0.059, blue: 0.110, alpha: 1)
    static let wood = NSColor(srgbRed: 0.949, green: 0.780, blue: 0.529, alpha: 1)
    static let paper = NSColor(srgbRed: 0.847, green: 0.871, blue: 0.933, alpha: 1)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = StatusView.navy.cgColor
        appearance = NSAppearance(named: .darkAqua)

        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 21, weight: .bold)
        titleLabel.textColor = StatusView.wood
        titleLabel.lineBreakMode = .byWordWrapping
        titleLabel.maximumNumberOfLines = 3

        messageLabel.font = .systemFont(ofSize: 13.5)
        messageLabel.textColor = StatusView.paper
        messageLabel.isSelectable = true

        detailView.isEditable = false
        detailView.isSelectable = true
        detailView.isRichText = false
        detailView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detailView.textColor = StatusView.paper
        detailView.backgroundColor = StatusView.ink
        detailView.textContainerInset = NSSize(width: 8, height: 8)
        detailView.isVerticallyResizable = true
        detailView.autoresizingMask = [.width]
        detailView.textContainer?.widthTracksTextView = true
        detailScroll.documentView = detailView
        detailScroll.hasVerticalScroller = true
        detailScroll.borderType = .noBorder
        detailScroll.drawsBackground = true
        detailScroll.backgroundColor = StatusView.ink
        detailScroll.wantsLayer = true
        detailScroll.layer?.cornerRadius = 6
        detailScroll.layer?.borderWidth = 1
        detailScroll.layer?.borderColor = NSColor(srgbRed: 0.20, green: 0.25, blue: 0.42, alpha: 1).cgColor
        detailScroll.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        buttonRow.orientation = .horizontal
        buttonRow.spacing = 10

        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 14
        column.translatesAutoresizingMaskIntoConstraints = false
        for v in [icon, titleLabel, messageLabel, detailScroll, spinner, buttonRow] as [NSView] { column.addArrangedSubview(v) }
        column.setCustomSpacing(18, after: icon)
        column.setCustomSpacing(8, after: titleLabel)
        column.setCustomSpacing(18, after: detailScroll)
        addSubview(column)

        let wide = column.widthAnchor.constraint(equalToConstant: 660)
        wide.priority = .defaultHigh
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 72),
            icon.heightAnchor.constraint(equalToConstant: 72),
            column.centerXAnchor.constraint(equalTo: centerXAnchor),
            column.centerYAnchor.constraint(equalTo: centerYAnchor),
            column.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -80),
            column.heightAnchor.constraint(lessThanOrEqualTo: heightAnchor, constant: -48),
            wide,
            titleLabel.widthAnchor.constraint(equalTo: column.widthAnchor),
            messageLabel.widthAnchor.constraint(equalTo: column.widthAnchor),
            detailScroll.widthAnchor.constraint(equalTo: column.widthAnchor),
            detailScroll.heightAnchor.constraint(equalToConstant: 170),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // The view is opaque for the mouse: nothing reaches the web view under it.
    override func mouseDown(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}

    func show(kind: String, title: String, message: String, detail: String? = nil, busy: Bool = false, actions: [Action] = []) {
        self.kind = kind
        titleText = title
        messageText = message
        detailText = detail ?? ""
        self.actions = actions
        titleLabel.stringValue = title
        messageLabel.stringValue = message
        messageLabel.isHidden = message.isEmpty
        detailView.string = detailText
        detailScroll.isHidden = detailText.isEmpty
        if !detailText.isEmpty { detailView.scrollToEndOfDocument(nil) }       // the last lines matter most
        if busy { spinner.isHidden = false; spinner.startAnimation(nil) } else { spinner.stopAnimation(nil); spinner.isHidden = true }
        buttonRow.arrangedSubviews.forEach { buttonRow.removeArrangedSubview($0); $0.removeFromSuperview() }
        for (i, a) in actions.enumerated() {
            let b = NSButton(title: a.title, target: self, action: #selector(pressed(_:)))
            b.bezelStyle = .rounded
            b.controlSize = .large
            b.tag = i
            if i == 0 { b.keyEquivalent = "\r" }
            buttonRow.addArrangedSubview(b)
        }
        buttonRow.isHidden = actions.isEmpty
        isHidden = false
        needsLayout = true
    }

    func hide() {
        guard !isHidden else { return }
        isHidden = true
        spinner.stopAnimation(nil)
        kind = ""
        actions = []
        buttonRow.arrangedSubviews.forEach { buttonRow.removeArrangedSubview($0); $0.removeFromSuperview() }   // no stray Return key
    }

    @objc private func pressed(_ sender: NSButton) { press(sender.tag + 1) }

    /// Runs the n-th action (1-based). Returns false when there is none.
    @discardableResult
    func press(_ n: Int) -> Bool {
        guard !isHidden, n >= 1, n <= actions.count else { return false }
        actions[n - 1].handler()
        return true
    }
}
