import Foundation

struct ProxyCredential: Decodable, Sendable {
    let type: String
    let email: String?
    let disabled: Bool?
    let access_token: String?
    let account_id: String?
}

struct DiscoveredAccount: Sendable {
    let id: String
    let provider: String
    let email: String
    let credential: ProxyCredential?
}

enum ProxyDiscovery {
    static func accounts(in directory: URL) throws -> [DiscoveredAccount] {
        let files = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: [.skipsHiddenFiles])
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        return files.map { file in
            let credential: ProxyCredential?
            do {
                let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true,
                      let size = values.fileSize, size <= 1_000_000 else { throw AcquisitionError(.unreadableCredentials) }
                credential = try JSONDecoder().decode(ProxyCredential.self, from: Data(contentsOf: file))
            } catch { credential = nil }
            let provider = credential?.type.lowercased()
                ?? String(file.lastPathComponent.split(separator: "-").first ?? "unknown")
            let email = credential?.email.flatMap(ProviderReadings.text)
                ?? file.deletingPathExtension().lastPathComponent
            return DiscoveredAccount(id: file.lastPathComponent, provider: provider, email: email, credential: credential)
        }
    }
}
