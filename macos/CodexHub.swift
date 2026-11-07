import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var process: Process?
    private var output = Data()
    private var panelPort: Int?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var terminationRequested = false
    private var terminationTimeout: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "codex手机助手"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "pairRequest")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView = webView
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
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出 codex手机助手", action: #selector(quitApp), keyEquivalent: ""))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        startRuntime()
    }

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
        child.standardOutput = pipe
        child.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                self?.consumeRuntimeOutput(data)
            }
        }
        child.terminationHandler = { [weak self] _ in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.terminationTimeout?.cancel()
                if self.terminationRequested { NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.showError() }
            }
        }
        do { try child.run(); process = child } catch { showError() }
    }

    private func consumeRuntimeOutput(_ data: Data) {
        output.append(data)
        while let newline = output.firstIndex(of: 10) {
            let line = String(data: output[..<newline], encoding: .utf8) ?? ""
            output.removeSubrange(...newline)
            if line == "STOP_BLOCKED", terminationRequested {
                cancelTermination(message: "任务仍在运行或等待确认，请处理完成后再退出。")
            } else if panelPort == nil, line.hasPrefix("PANEL_URL="),
                      let url = URL(string: String(line.dropFirst("PANEL_URL=".count))),
                      url.scheme == "http", url.host == "127.0.0.1", let port = url.port {
                panelPort = port
                webView.load(URLRequest(url: url))
            }
        }
        if output.count > 65536 { output.removeAll(keepingCapacity: true) }
    }

    private func cancelTermination(message: String) {
        guard terminationRequested else { return }
        terminationRequested = false
        terminationTimeout?.cancel()
        terminationTimeout = nil
        NSApp.reply(toApplicationShouldTerminate: false)
        showWindow()
        let alert = NSAlert()
        alert.messageText = "暂时无法退出"
        alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        alert.beginSheetModal(for: window)
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
        let timeout = DispatchWorkItem { [weak self] in
            self?.cancelTermination(message: "助手尚未完成退出，请稍后再试。")
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
