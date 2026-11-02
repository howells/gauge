import Foundation

struct UsageHTTPResponse: Sendable {
    let status: Int
    let data: Data
    var retryAfter: String? = nil
}

typealias UsageTransport = @Sendable (URLRequest) async throws -> UsageHTTPResponse

private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum UsageHTTP {
    static func transport() -> UsageTransport {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config, delegate: RedirectBlocker(), delegateQueue: nil)
        return { request in
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, data.count <= 1_000_000 else {
                throw AcquisitionError(.invalidResponse)
            }
            return UsageHTTPResponse(status: response.statusCode, data: data,
                                     retryAfter: response.value(forHTTPHeaderField: "Retry-After"))
        }
    }

    static func request(_ address: String, token: String, provider: String, accountID: String? = nil) throws -> URLRequest {
        guard !token.isEmpty, !token.contains(where: { $0.isNewline || $0.asciiValue == 0 }) else {
            throw AcquisitionError(.missingCredentials)
        }
        guard let url = URL(string: address) else { throw AcquisitionError(.invalidResponse) }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if provider == "claude" { request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta") }
        if let accountID, !accountID.contains(where: { $0.isNewline }) {
            request.setValue(accountID, forHTTPHeaderField: "ChatGPT-Account-Id")
        }
        return request
    }

    static func validated(_ response: UsageHTTPResponse) throws -> Data {
        guard (200..<300).contains(response.status) else {
            let code: FailureCode = switch response.status {
            case 401: .authentication
            case 403: .forbidden
            case 429: .rateLimited
            default: .network
            }
            throw AcquisitionError(code, httpStatus: response.status)
        }
        return response.data
    }
}

struct AcquisitionError: Error {
    let failure: UsageFailure

    init(_ code: FailureCode, httpStatus: Int? = nil) {
        failure = UsageFailure(code, httpStatus: httpStatus)
    }
}
