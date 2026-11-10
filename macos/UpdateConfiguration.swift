import Foundation
import CryptoKit

// Configuration is sealed into the signed application. Never read a key or feed
// from the web panel, environment, or a downloaded manifest at runtime.
enum UpdateConfiguration {
    static func isValid(_ info: [String: Any]) -> Bool {
        guard let feed = info["SUFeedURL"] as? String,
              !feed.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let url = URLComponents(string: feed), url.scheme == "https",
              url.url != nil,
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.fragment == nil,
              let encoded = info["SUPublicEDKey"] as? String,
              let key = Data(base64Encoded: encoded), key.count == 32,
              key.base64EncodedString() == encoded, key.contains(where: { $0 != 0 }),
              (try? Curve25519.Signing.PublicKey(rawRepresentation: key)) != nil,
              info["SUAllowsAutomaticUpdates"] as? Bool == false,
              info["SUAutomaticallyUpdate"] as? Bool == false,
              info["SUVerifyUpdateBeforeExtraction"] as? Bool == true,
              info["SURequireSignedFeed"] as? Bool == true,
              info["SUSignedFeedFailureExpirationInterval"] as? Int == 0 else { return false }
        return true
    }
}
