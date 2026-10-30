//
//  SafariWebExtensionHandler.swift
//  Pond Safari extension
//
//  Safari cannot launch `pond-native-host` the way Chrome's NativeMessagingHosts
//  mechanism does. `browser.runtime.sendNativeMessage` in a Safari App Extension routes
//  here instead, so this handler is the async-side counterpart of
//  `native-host/pond-native-host.c`.
//
//  It deliberately does nothing but move bytes. Requests and responses are validated by
//  the shared Zod contracts in `packages/schema/src/native.ts`, which the extension
//  applies in `utils/native.ts`, so adding validation here would duplicate the contract
//  and risk the two drifting apart.
//
//  Transport is a Unix socket Pond listens on (`src/main/native/server.ts`), with the
//  same 4-byte little-endian length prefix followed by UTF-8 JSON that
//  `pond-native-host.c` writes. The sandbox only lets this extension connect inside
//  the App Group container it shares with Pond, so Pond binds a second socket there.
//
//  When Pond is closed, a save (`enqueue` or `capture.accept`) is written to `Inbox/`
//  in the same container instead, without its cookies, and Pond dispatches it at launch
//  (`src/main/native/offline-inbox.ts`). Every other request still answers `offline`.
//

import Foundation
import SafariServices
import os.log

/// Mirrors MAX_MSG / MAX_RESPONSE in native-host/pond-native-host.c.
private let maxMessageBytes = 8 * 1024 * 1024
private let maxResponseBytes = 1024 * 1024 - 4096

/**
 * `Logger` needs macOS 11 and `os_log` does not, and the converter picks its own
 * deployment target per Xcode version (10.14 on Xcode 26, 12.0 on 27). Using `os_log`
 * keeps this file compiling on both without an `@available` dance.
 */
private let log = OSLog(subsystem: "so.pond.desktop.Extension", category: "native-host")

/// Mirrors SAFARI_APP_GROUP in packages/schema/src/native.ts and Pond's entitlements.
private let appGroup = "7VFLYD5292.so.pond"

/// Mirrors NATIVE_INBOX_DIR in packages/schema/src/native.ts.
private let inboxDirectory = "Inbox"

/// Requests that save something; only these wait in the inbox while Pond is closed.
private let queuedTypes: Set<String> = ["enqueue", "capture.accept"]

private let offlineReply = #"{"ok":false,"error":"offline"}"#
private let queuedReply = #"{"ok":true,"data":{"queued":true}}"#

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // Safari hands the request over as a single NSExtensionItem whose attachment is
        // the JSON body the extension passed to sendNativeMessage.
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]

        guard let payload = serialize(message),
              let request = payload.data(using: .utf8) else {
            respond(context, body: offlineReply)
            return
        }

        guard request.count <= maxMessageBytes else {
            respond(context, body: #"{"ok":false,"error":"too_large"}"#)
            return
        }

        guard let fd = connectToPond() else {
            respond(context, body: queue(message) ? queuedReply : offlineReply)
            return
        }
        defer { close(fd) }
        respond(context, body: exchange(fd, request) ?? offlineReply)
    }

    private func serialize(_ message: Any?) -> String? {
        guard let message,
              JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func respond(_ context: NSExtensionContext, body: String) {
        // `nativeCall` reads the reply object itself, so it goes in unwrapped: Safari does
        // not add a layer of its own around the message.
        let response = NSExtensionItem()
        let payload: Any = jsonObject(body) ?? ["ok": false, "error": "offline"]
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func jsonObject(_ body: String) -> Any? {
        guard let data = body.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// Returns a socket connected to Pond, or nil when Pond is not listening.
    private func connectToPond() -> Int32? {
        guard let path = socketPath() else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else {
            close(fd)
            return nil
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: path.utf8)
        }

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            os_log("connect failed: %{public}d", log: log, type: .debug, errno)
            close(fd)
            return nil
        }
        return fd
    }

    /// Sends the framing Pond expects and reads one framed reply back.
    private func exchange(_ fd: Int32, _ request: Data) -> String? {
        guard writeFramed(fd, request), let reply = readFramed(fd) else { return nil }
        return String(data: reply, encoding: .utf8)
    }

    /// Mirrors `safariSocketPath` in `src/main/native/paths.ts`.
    private func socketPath() -> String? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("native.sock")
            .path
    }

    /// Mirrors `safariInboxPath` in `src/main/native/paths.ts`.
    private func inboxURL() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(inboxDirectory, isDirectory: true)
    }

    /// Leaves a save in the inbox for Pond's next launch. Session cookies never reach the
    /// disk, so a page that needs a signed-in session is saved signed out.
    private func queue(_ message: Any?) -> Bool {
        guard var request = message as? [String: Any],
              let type = request["type"] as? String,
              queuedTypes.contains(type),
              let inbox = inboxURL() else { return false }
        request.removeValue(forKey: "cookies")
        guard JSONSerialization.isValidJSONObject(request),
              let body = try? JSONSerialization.data(withJSONObject: request),
              body.count <= maxMessageBytes else { return false }

        do {
            try FileManager.default.createDirectory(
                at: inbox,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            os_log("inbox unavailable: %{public}@", log: log, type: .error, "\(error)")
            return false
        }

        // The millisecond prefix keeps Pond's drain in the order the saves were made.
        let millis = UInt64(Date().timeIntervalSince1970 * 1000)
        let name = String(format: "%013llu-%@", millis, UUID().uuidString)
        let temp = inbox.appendingPathComponent(".\(name).tmp").path
        let final = inbox.appendingPathComponent("\(name).json").path

        // A hidden temp file renamed into place, so Pond never reads half a save.
        let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return false }
        let written = writeAll(fd, body) && fsync(fd) == 0
        close(fd)
        guard written, rename(temp, final) == 0 else {
            unlink(temp)
            return false
        }
        return true
    }

    private func writeFramed(_ fd: Int32, _ body: Data) -> Bool {
        var length = UInt32(body.count).littleEndian
        let header = withUnsafeBytes(of: &length) { Data($0) }
        return writeAll(fd, header) && writeAll(fd, body)
    }

    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var offset = 0
        return data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return data.isEmpty }
            while offset < data.count {
                let written = write(fd, base + offset, data.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += written
            }
            return true
        }
    }

    private func readFramed(_ fd: Int32) -> Data? {
        guard let header = readExactly(fd, 4) else { return nil }
        let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let size = Int(UInt32(littleEndian: length))
        guard size > 0, size <= maxMessageBytes else { return nil }
        guard size <= maxResponseBytes else { return nil }
        return readExactly(fd, size)
    }

    private func readExactly(_ fd: Int32, _ count: Int) -> Data? {
        var buffer = Data(count: count)
        var offset = 0
        let ok = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            while offset < count {
                let got = read(fd, base + offset, count - offset)
                if got == 0 { return false }
                if got < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += got
            }
            return true
        }
        return ok ? buffer : nil
    }
}
