import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var process: Process?
    private var output = Data()
    private var panelPort: Int?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!

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
        child.arguments = [resources.appendingPathComponent("runtime/mac-app-runtime.mjs").path]
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
                guard let self = self, self.output.count < 4096 else { return }
                self.output.append(data)
                guard let raw = String(data: self.output, encoding: .utf8), raw.contains("\n"),
                      let line = raw.split(separator: "\n").first,
                      line.hasPrefix("PANEL_URL="),
                      let url = URL(string: String(line.dropFirst("PANEL_URL=".count))),
                      url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { return }
                handle.readabilityHandler = nil
                self.panelPort = url.port
                self.webView.load(URLRequest(url: url))
            }
        }
        child.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.showError() } }
        do { try child.run(); process = child } catch { showError() }
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
    func applicationWillTerminate(_ notification: Notification) {
        if let child = process, child.isRunning { child.terminate(); child.waitUntilExit() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
