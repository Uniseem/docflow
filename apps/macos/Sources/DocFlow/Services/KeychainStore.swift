import Foundation
import Security

/// API keys live in the login keychain, all in one generic password
/// (service "DocFlow", account "api-keys") holding a JSON object of engine
/// key names (`mineru`, `provider:<id>`) to values. One item means macOS
/// asks at most once for access after an update, however many providers
/// there are. Keys are handed to the engine in memory and never written to
/// the library.
enum KeychainStore {
    static let mineru = "mineru"

    private static let service = "DocFlow"
    private static let account = "api-keys"

    static func providerName(_ providerID: String) -> String {
        "provider:\(providerID)"
    }

    static func readAll() -> [String: String] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let values = try? JSONDecoder().decode([String: String].self, from: data)
        else {
            return [:]
        }
        return values.filter { !$0.value.isEmpty }
    }

    static func write(_ name: String, _ value: String) throws {
        var values = readAll()
        values[name] = value
        try store(values)
    }

    static func delete(_ name: String) throws {
        var values = readAll()
        guard values.removeValue(forKey: name) != nil else { return }
        try store(values)
    }

    private static func store(_ values: [String: String]) throws {
        let data = try JSONEncoder().encode(values)
        let status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery
            item[kSecValueData as String] = data
            item[kSecAttrLabel as String] = "DocFlow API Keys"
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

struct KeychainError: LocalizedError {
    var status: OSStatus

    var errorDescription: String? {
        if let message = SecCopyErrorMessageString(status, nil) as String? {
            return "无法访问钥匙串：\(message)"
        }
        return "无法访问钥匙串（错误 \(status)）"
    }
}
