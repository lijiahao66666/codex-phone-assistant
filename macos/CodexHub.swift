import Cocoa
import WebKit
import Darwin
import Sparkle

private final class RuntimeStderrTail {
    private let handle: FileHandle
    private let lock = NSLock()
    private let limit = 64 * 1024
    private var bytes = Data()
    private var closed = false

    init?(_ handle: FileHandle) {
        self.handle = handle
        let flags = fcntl(handle.fileDescriptor, F_GETFL)
        guard flags >= 0, fcntl(handle.fileDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { return nil }
    }

    private func drainLocked() {
        guard !closed else { return }
        var buffer = [UInt8](repeating: 0, count: 4096)
        var remaining = limit
        while remaining > 0 {
            let count = Darwin.read(handle.fileDescriptor, &buffer, min(buffer.count, remaining))
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { break }
            remaining -= count
            let excess = bytes.count + count - limit
            if excess > 0 { bytes.removeFirst(excess) }
            bytes.append(contentsOf: buffer.prefix(count))
        }
    }

    func drain() {
        lock.lock()
        defer { lock.unlock() }
        drainLocked()
    }

    func finish() -> Data {
        lock.lock()
        defer { lock.unlock() }
        drainLocked()
        closed = true
        try? handle.close()
        return bytes
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var process: Process?
    private var output = Data()
    private var panelPort: Int?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var terminationRequested = false
    private var terminationTimeout: DispatchWorkItem?
    private var terminationWaitAlert: NSAlert?
    private var updaterController: SPUStandardUpdaterController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "codex手机助手"
        window.minSize = NSSize(width: 320, height: 300)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "pairRequest")
        let container = NSView(frame: window.contentView!.bounds)
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        actions.translatesAutoresizingMaskIntoConstraints = false
        let checkButton = NSButton(title: "检查更新…", target: self, action: #selector(checkForUpdates))
        checkButton.isEnabled = UpdateConfiguration.isValid(Bundle.main.infoDictionary ?? [:])
        actions.addArrangedSubview(checkButton)
        actions.addArrangedSubview(NSButton(title: "退出助手", target: self, action: #selector(quitApp)))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        container.addSubview(actions)
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            actions.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
            actions.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            webView.topAnchor.constraint(equalTo: actions.bottomAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(named: NSImage.applicationIconName)
            button.image?.size = NSSize(width: 18, height: 18)
            button.image?.accessibilityDescription = "codex手机助手"
            if button.image == nil { button.title = "C" }
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "打开 codex手机助手", action: #selector(showWindow), keyEquivalent: ""))
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let versionItem = NSMenuItem(title: "版本 \(version) (\(build))", action: nil, keyEquivalent: "")
        menu.addItem(versionItem)
        configureUpdater(in: menu)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出 codex手机助手", action: #selector(quitApp), keyEquivalent: ""))
        for item in menu.items where item.target == nil && item.action != nil { item.target = self }
        statusItem.menu = menu
        startRuntime()
    }

    private func configureUpdater(in menu: NSMenu) {
        guard UpdateConfiguration.isValid(Bundle.main.infoDictionary ?? [:]) else {
            menu.addItem(NSMenuItem(title: "检查更新（未配置）", action: nil, keyEquivalent: ""))
            return
        }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        updaterController = controller
        let check = NSMenuItem(title: "检查更新…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        check.target = controller
        menu.addItem(check)
        let automatic = NSMenuItem(title: "自动检查更新", action: #selector(toggleAutomaticUpdateChecks(_:)), keyEquivalent: "")
        automatic.target = self
        automatic.state = controller.updater.automaticallyChecksForUpdates ? .on : .off
        menu.addItem(automatic)
        // Sparkle requests normal NSApplication termination and waits for this
        // application's actual exit before replacing its bundle. Runtime cleanup
        // completes before applicationShouldTerminate approves termination.
        // Silent automatic installation is disabled in the sealed Info.plist.
    }

    @objc private func toggleAutomaticUpdateChecks(_ sender: NSMenuItem) {
        guard let updater = updaterController?.updater else { return }
        updater.automaticallyChecksForUpdates.toggle()
        sender.state = updater.automaticallyChecksForUpdates ? .on : .off
    }

    @objc private func checkForUpdates() { updaterController?.checkForUpdates(nil) }

    @objc private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func quitApp() { NSApp.terminate(nil) }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "pairRequest", message.frameInfo.isMainFrame,
              message.body as? String == "pending", let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == panelPort else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        showWindow()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    private func startRuntime() {
        guard let resources = Bundle.main.resourceURL else { showError(); return }
        let child = Process()
        child.executableURL = resources.appendingPathComponent("node")
        child.arguments = [resources.appendingPathComponent("runtime/src/runtime.mjs").path]
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        environment["HUB_IMAGE_PREVIEW"] = "1"
        environment["HUB_IMAGE_UPLOAD"] = "1"
        child.environment = environment
        let pipe = Pipe()
        let stderrPipe = Pipe()
        let stderrTail = RuntimeStderrTail(stderrPipe.fileHandleForReading)
        child.standardOutput = pipe
        child.standardError = stderrTail == nil ? FileHandle.nullDevice : stderrPipe
        if let stderrTail = stderrTail {
            stderrPipe.fileHandleForReading.readabilityHandler = { _ in stderrTail.drain() }
        }
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                self?.consumeRuntimeOutput(data)
            }
        }
        child.terminationHandler = { [weak self] child in
            pipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            let tail = stderrTail?.finish() ?? Data()
            let exitedAt = Date()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.terminationTimeout?.cancel()
                self.dismissTerminationWaitAlert()
                if self.terminationRequested { NSApp.reply(toApplicationShouldTerminate: true) }
                else {
                    self.recordRuntimeExit(child, at: exitedAt, stderrTail: tail)
                    self.showError()
                }
            }
        }
        do { try child.run(); process = child } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            _ = stderrTail?.finish()
            showError()
        }
    }

    private func recordRuntimeExit(_ child: Process, at timestamp: Date, stderrTail: Data) {
        let reason: String
        switch child.terminationReason {
        case .exit: reason = "exit"
        case .uncaughtSignal: reason = "uncaughtSignal"
        @unknown default: reason = "unknown"
        }
        let record: [String: Any] = [
            "status": child.terminationStatus,
            "reason": reason,
            "timestamp": ISO8601DateFormatter().string(from: timestamp),
            "stderrTail": String(decoding: stderrTail, as: UTF8.self),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex-phone", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch { return }
        let path = directory.appendingPathComponent("last-runtime-exit.json").path
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return }
        defer { Darwin.close(descriptor) }
        guard fchmod(descriptor, 0o600) == 0 else { return }
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { return }
                offset += count
            }
        }
    }

    private func consumeRuntimeOutput(_ data: Data) {
        output.append(data)
        while let newline = output.firstIndex(of: 10) {
            let line = String(data: output[..<newline], encoding: .utf8) ?? ""
            output.removeSubrange(...newline)
            if panelPort == nil, line.hasPrefix("PANEL_URL="),
                      let url = URL(string: String(line.dropFirst("PANEL_URL=".count))),
                      url.scheme == "http", url.host == "127.0.0.1", let port = url.port {
                panelPort = port
                webView.load(URLRequest(url: url))
            }
        }
        if output.count > 65536 { output.removeAll(keepingCapacity: true) }
    }

    private func dismissTerminationWaitAlert() {
        if let alert = terminationWaitAlert { window.endSheet(alert.window); terminationWaitAlert = nil }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == panelPort ? .allow : .cancel)
    }

    private func showError() {
        webView.loadHTMLString("<p>codex手机助手启动失败，请关闭后重试。</p>", baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child = process, child.isRunning else { return .terminateNow }
        if terminationRequested { return .terminateLater }
        terminationRequested = true
        // An explicit quit stops this assistant's runtime even while it is busy.
        // Wait for cleanup and actual exit before allowing bundle replacement.
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, self.terminationRequested else { return }
            let alert = NSAlert()
            alert.messageText = "正在等待助手退出"
            alert.informativeText = "助手仍在完成退出，请稍候。"
            self.terminationWaitAlert = alert
            alert.beginSheetModal(for: self.window) { [weak self] _ in self?.terminationWaitAlert = nil }
        }
        terminationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
        child.terminate()
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        terminationTimeout?.cancel()
    }
}

@main
private enum CodexHubMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
