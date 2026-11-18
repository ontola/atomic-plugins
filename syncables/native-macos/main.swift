import AppKit
import CryptoKit
import Darwin
import Foundation
import Photos
import UniformTypeIdentifiers

// The app reads one private request and writes an atomic, metadata-only response.
let arguments = CommandLine.arguments
guard arguments.count == 3 else { exit(2) }
let requestURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
let manager = FileManager.default
let dateFormatter = ISO8601DateFormatter()
let fractionalDateFormatter = ISO8601DateFormatter()
fractionalDateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
umask(0o077)

@MainActor
func emit(_ value: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try data.write(to: outputURL, options: .atomic)
  } catch { exit(1) }
}

@MainActor
func stamp(_ date: Date?) -> Any {
  guard let date = date else { return NSNull() }
  return dateFormatter.string(from: date)
}

@MainActor
func metadata(_ url: URL, root: URL) throws -> [String: Any] {
  let keys: Set<URLResourceKey> = [
    .nameKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey,
    .contentModificationDateKey, .creationDateKey, .isUbiquitousItemKey,
    .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsUploadedKey,
    .ubiquitousItemIsUploadingKey, .ubiquitousItemUploadingErrorKey,
    .ubiquitousItemDownloadingErrorKey, .ubiquitousItemIsDownloadingKey,
  ]
  let values = try url.resourceValues(forKeys: keys)
  let path = String(url.path.dropFirst(root.path.count + 1))
  let id = Data(path.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  var row: [String: Any] = [
    "id": id, "name": values.name ?? url.lastPathComponent,
    "path": path,
    "kind": values.isSymbolicLink == true
      ? "symlink" : values.isDirectory == true ? "directory" : "file",
    "createdTime": stamp(values.creationDate),
    "modifiedTime": stamp(values.contentModificationDate),
    "ubiquitous": values.isUbiquitousItem ?? false,
  ]
  if let size = values.fileSize { row["size"] = String(size) }
  if let status = values.ubiquitousItemDownloadingStatus { row["downloadStatus"] = status.rawValue }
  if values.ubiquitousItemIsDownloading == true { row["downloadStatus"] = "downloading" }
  if let uploaded = values.ubiquitousItemIsUploaded { row["uploaded"] = uploaded }
  if let uploading = values.ubiquitousItemIsUploading { row["uploading"] = uploading }
  if let error = values.ubiquitousItemUploadingError as NSError? {
    row["uploadError"] = ["domain": error.domain, "code": error.code]
  }
  if let error = values.ubiquitousItemDownloadingError as NSError? {
    row["downloadError"] = ["domain": error.domain, "code": error.code]
    if values.ubiquitousItemDownloadingStatus != .current
      && values.ubiquitousItemDownloadingStatus != .downloaded
      && values.ubiquitousItemIsDownloading != true
    {
      row["downloadStatus"] = "failed"
    }
  }
  return row
}

@MainActor
func drive(_ request: [String: Any]) throws -> [String: Any] {
  let root = URL(fileURLWithPath: request["directory"] as! String).standardizedFileURL
  if let path = request["path"] as? String {
    guard !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else {
      throw CocoaError(.fileReadInvalidFileName)
    }
    return ["item": try metadata(root.appendingPathComponent(path), root: root)]
  }
  var rows = [[String: Any]]()
  func walk(_ folder: URL) throws {
    for entry in try manager.contentsOfDirectory(
      at: folder, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    {
      // A crashed transfer can leave a private staging file until recovery.
      if entry.lastPathComponent.hasPrefix(".syncables-transfer-") { continue }
      let row = try metadata(entry, root: root)
      rows.append(row)
      if rows.count > 250_000 { throw CocoaError(.fileReadTooLarge) }
      if row["kind"] as? String == "directory" { try walk(entry) }
    }
  }
  try walk(root)
  return [
    "items": rows,
    "scope": [
      "directory": root.path, "view": "macOS-local", "symlinks": "listed-without-traversal",
    ], "complete": true,
  ]
}

@MainActor
func photos() throws -> [String: Any] {
  let options = PHFetchOptions()
  options.includeAssetSourceTypes = .typeUserLibrary
  options.includeHiddenAssets = false
  let assets = PHAsset.fetchAssets(with: options)
  guard assets.count <= 250_000 else { throw CocoaError(.fileReadTooLarge) }
  var rows = [[String: Any]]()
  for offset in stride(from: 0, to: assets.count, by: 256) {
    autoreleasepool {
      let batch = (offset..<min(offset + 256, assets.count)).map { assets.object(at: $0) }
      let mappings = PHPhotoLibrary.shared().cloudIdentifierMappings(
        forLocalIdentifiers: batch.map(\.localIdentifier))
      for asset in batch {
        let resources = PHAssetResource.assetResources(for: asset)
        var row: [String: Any] = [
          "id": asset.localIdentifier, "localIdentifier": asset.localIdentifier,
          "mediaType": asset.mediaType == .video
            ? "video" : asset.mediaType == .image ? "photo" : "other",
          "createdTime": stamp(asset.creationDate), "modifiedTime": stamp(asset.modificationDate),
          "pixelWidth": asset.pixelWidth, "pixelHeight": asset.pixelHeight,
          "livePhoto": asset.mediaSubtypes.contains(.photoLive),
          "resources": resources.map {
            [
              "name": $0.originalFilename, "type": $0.type.rawValue,
              "uniformTypeIdentifier": $0.uniformTypeIdentifier,
            ] as [String: Any]
          },
        ]
        if let first = resources.first { row["name"] = first.originalFilename }
        if asset.mediaType == .video { row["durationSeconds"] = asset.duration }
        if case .success(let cloud)? = mappings[asset.localIdentifier] {
          row["cloudIdentifier"] = cloud.stringValue
        }
        rows.append(row)
      }
    }
  }
  return [
    "items": rows,
    "scope": [
      "library": "system-photo-library", "assetSources": "user-library",
      "hidden": false, "recentlyDeleted": false, "sharedAlbums": false, "view": "macOS-local",
    ], "complete": true,
  ]
}

// Walk each destination directory by descriptor, refusing symlinks and traversal.
// Files are published with linkat, which atomically refuses an existing target.
@MainActor
func write(_ request: [String: Any]) throws -> [String: Any] {
  let root = request["directory"] as! String
  let path = request["path"] as! String
  let parts = path.components(separatedBy: "/")
  guard !parts.isEmpty,
    parts.allSatisfy({
      !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0")
        && !$0.hasPrefix(".syncables-transfer-")
    })
  else {
    throw CocoaError(.fileWriteInvalidFileName)
  }
  var directory = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  guard directory >= 0 else { throw POSIXError(.EACCES) }
  defer { close(directory) }
  for part in parts.dropLast() {
    if mkdirat(directory, part, 0o700) != 0 && errno != EEXIST { throw POSIXError(.EACCES) }
    let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard next >= 0 else { throw POSIXError(.EACCES) }
    close(directory)
    directory = next
  }
  let name = parts.last!
  if request["kind"] as? String == "directory" {
    guard mkdirat(directory, name, 0o700) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  } else {
    let blob = request["blob"] as! String
    let expected = request["sha256"] as! String
    let input = open(blob, O_RDONLY | O_NOFOLLOW)
    guard input >= 0 else { throw POSIXError(.ENOENT) }
    defer { close(input) }
    let temporary = ".syncables-transfer-" + UUID().uuidString
    let output = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard output >= 0 else { throw POSIXError(.EIO) }
    defer {
      close(output)
      unlinkat(directory, temporary, 0)
    }
    var digest = SHA256()
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    while true {
      let count = Darwin.read(input, &buffer, buffer.count)
      guard count >= 0 else { throw POSIXError(.EIO) }
      if count == 0 { break }
      digest.update(data: Data(buffer[0..<count]))
      var offset = 0
      while offset < count {
        let written = buffer.withUnsafeBytes { pointer in
          Darwin.write(output, pointer.baseAddress!.advanced(by: offset), count - offset)
        }
        guard written > 0 else { throw POSIXError(.EIO) }
        offset += written
      }
    }
    let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
    guard actual == expected else { throw CocoaError(.fileReadCorruptFile) }
    if let modified = request["modifiedTime"] as? String {
      guard
        let date = dateFormatter.date(from: modified)
          ?? fractionalDateFormatter.date(from: modified)
      else { throw CocoaError(.fileWriteInvalidFileName) }
      let seconds = floor(date.timeIntervalSince1970)
      let nanoseconds = Int(((date.timeIntervalSince1970 - seconds) * 1_000).rounded()) * 1_000_000
      var times = [
        timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT)),
        timespec(tv_sec: Int(seconds), tv_nsec: nanoseconds),
      ]
      guard futimens(output, &times) == 0 else { throw POSIXError(.EIO) }
    }
    guard fsync(output) == 0 else { throw POSIXError(.EIO) }
    guard linkat(directory, temporary, directory, name, 0) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }
  // Some filesystems do not support directory fsync. The item itself is durable.
  _ = fsync(directory)
  return ["localStatus": "written"]
}

@MainActor
func content(_ request: [String: Any]) throws -> [String: Any] {
  let parts = (request["path"] as! String).components(separatedBy: "/")
  guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }) else {
    throw CocoaError(.fileReadInvalidFileName)
  }
  var directory = open(request["directory"] as! String, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  guard directory >= 0 else { throw POSIXError(.EACCES) }
  defer { close(directory) }
  for part in parts.dropLast() {
    let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard next >= 0 else { throw POSIXError(.EACCES) }
    close(directory)
    directory = next
  }
  let input = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  guard input >= 0 else { throw POSIXError(.ENOENT) }
  defer { close(input) }
  var information = stat()
  guard fstat(input, &information) == 0, information.st_mode & S_IFMT == S_IFREG,
    information.st_size <= 1024 * 1024 * 1024
  else { throw CocoaError(.fileReadUnsupportedScheme) }
  let output = open(request["export"] as! String, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  guard output >= 0 else { throw POSIXError(.EIO) }
  defer { close(output) }
  var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
  while true {
    let count = Darwin.read(input, &buffer, buffer.count)
    guard count >= 0 else { throw POSIXError(.EIO) }
    if count == 0 { break }
    var offset = 0
    while offset < count {
      let written = buffer.withUnsafeBytes { pointer in
        Darwin.write(output, pointer.baseAddress!.advanced(by: offset), count - offset)
      }
      guard written > 0 else { throw POSIXError(.EIO) }
      offset += written
    }
  }
  return ["exported": true]
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.main.async {
  do {
    let request =
      try JSONSerialization.jsonObject(with: Data(contentsOf: requestURL)) as! [String: Any]
    if request["operation"] as? String == "photos" {
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { authorization in
        guard authorization == .authorized else {
          DispatchQueue.main.async {
            emit([
              "error": "Photos access requires full library permission",
              "authorization": authorization.rawValue,
            ])
            app.terminate(nil)
          }
          return
        }
        DispatchQueue.main.async {
          do { emit(try photos()) } catch { emit(["error": "Photos metadata scan failed"]) }
          app.terminate(nil)
        }
      }
    } else {
      do {
        switch request["operation"] as? String {
        case "write": emit(try write(request))
        case "content": emit(try content(request))
        default: emit(try drive(request))
        }
      } catch {
        let e = error as NSError
        emit(["error": "Filesystem operation failed", "domain": e.domain, "code": e.code])
      }
      app.terminate(nil)
    }
  } catch {
    emit(["error": "Invalid connector request"])
    app.terminate(nil)
  }
}
app.run()
