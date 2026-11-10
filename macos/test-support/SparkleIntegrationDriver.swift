import Cocoa
import Sparkle

func testLog(_ event: String) {
    let path = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("events.log")
    let data = (event + "\n").data(using: .utf8)!
    if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: nil) }
    if let file = try? FileHandle(forWritingTo: path) { file.seekToEndOfFile(); file.write(data); try? file.close() }
}

final class IntegrationUserDriver: NSObject, SPUUserDriver {
    var retry: (() -> Void)?
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { testLog("checking") }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        if appcastItem.isInformationOnlyUpdate {
            testLog("information:" + (appcastItem.infoURL?.absoluteString ?? "missing"))
            reply(.dismiss)
            return
        }
        testLog("found:" + appcastItem.versionString); reply(.install)
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) { testLog("notes-error:" + error.localizedDescription) }
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { testLog("not-found:" + error.localizedDescription); acknowledgement() }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) { testLog("error:" + String(describing: error)); acknowledgement() }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { testLog("download") }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
    func showDownloadDidReceiveData(ofLength length: UInt64) {}
    func showDownloadDidStartExtractingUpdate() { testLog("extract") }
    func showExtractionReceivedProgress(_ progress: Double) {}
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) { testLog("ready"); reply(.install) }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        testLog("installing:" + String(applicationTerminated))
        retry = retryTerminatingApplication
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            let marker = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("retry")
            if FileManager.default.fileExists(atPath: marker.path) {
                try? FileManager.default.removeItem(at: marker); self?.retry?(); testLog("retry-quit"); timer.invalidate()
            }
        }
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { testLog("installed:" + String(relaunched)); acknowledgement() }
    func dismissUpdateInstallation() { testLog("dismiss") }
}
