import Foundation
import CryptoKit

@main
private enum UpdateConfigurationTests {
    static func main() {
        // Ephemeral test key remains in memory; no release private key is used.
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
        let valid: [String: Any] = ["SUFeedURL": "https://updates.example.com/appcast.xml",
                                   "SUPublicEDKey": key, "SUAllowsAutomaticUpdates": false,
                                   "SUAutomaticallyUpdate": false,
                                   "SUVerifyUpdateBeforeExtraction": true,
                                   "SURequireSignedFeed": true,
                                   "SUSignedFeedFailureExpirationInterval": 0]
        precondition(UpdateConfiguration.isValid(valid))
        precondition(!UpdateConfiguration.isValid([:]))
        for (field, replacement) in [
            ("SUPublicEDKey", "placeholder" as Any),
            ("SUPublicEDKey", Data(repeating: 0, count: 32).base64EncodedString()),
            ("SUPublicEDKey", key + "\n"),
            ("SUFeedURL", "http://updates.example.com/appcast.xml"),
            ("SUFeedURL", "https://user:password@updates.example.com/appcast.xml"),
            ("SUFeedURL", "https://updates.example.com/appcast.xml#fragment"),
            ("SUFeedURL", "https://updates.example.com/\nfile"),
            ("SUAllowsAutomaticUpdates", true), ("SUAutomaticallyUpdate", true),
            ("SUVerifyUpdateBeforeExtraction", false), ("SURequireSignedFeed", false),
            ("SUSignedFeedFailureExpirationInterval", 1728000),
        ] {
            var invalid = valid
            invalid[field] = replacement
            precondition(!UpdateConfiguration.isValid(invalid), "Accepted unsafe field: \(field)")
        }
        print("PASS: native updater accepts configured HTTPS/Ed25519 and rejects unsafe configuration")
    }
}
