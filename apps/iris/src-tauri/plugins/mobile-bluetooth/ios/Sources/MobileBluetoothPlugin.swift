import CoreBluetooth
import Foundation
import Tauri

struct StartArgs: Decodable {
  let localPeerId: String
}

struct SendArgs: Decodable {
  let address: String
  let kind: String
  let payloadBase64: String
}

private struct AddressEvent: Encodable {
  let address: String
}

private struct FrameEvent: Encodable {
  let address: String
  let kind: String
  let payloadBase64: String
}

private struct PeerSnapshot: Encodable {
  let address: String
  let ready: Bool
}

private struct PeerSnapshotResponse: Encodable {
  let peers: [PeerSnapshot]
}

private struct DecodedFrame {
  let kind: String
  let payload: Data
}

private struct PendingSend {
  let address: String
  let chunks: [Data]
  var nextIndex: Int
  let invoke: Invoke?
}

private let serviceUUID = CBUUID(string: "f18ef5f6-b7ee-4f40-b869-10a2d4f35932")
private let rxUUID = CBUUID(string: "0bb5f5c9-6369-4511-a84f-4d4c14d8f8d4")
private let txUUID = CBUUID(string: "4ec9c0c2-97c6-4f46-9fd1-927d699b2f6d")
private let chunkBytes = 180

private final class FrameDecoder {
  private var buffer = [UInt8]()

  func append(_ chunk: Data) -> [DecodedFrame] {
    buffer.append(contentsOf: chunk)
    var frames = [DecodedFrame]()

    while buffer.count >= 5 {
      let length =
        (Int(buffer[1]) << 24) | (Int(buffer[2]) << 16) | (Int(buffer[3]) << 8) | Int(buffer[4])
      guard buffer.count >= 5 + length else {
        break
      }

      let payload = Data(buffer[5..<(5 + length)])
      let kind: String
      switch buffer[0] {
      case 1:
        kind = "text"
      case 2:
        kind = "binary"
      default:
        buffer.removeAll()
        return frames
      }

      frames.append(DecodedFrame(kind: kind, payload: payload))
      buffer.removeFirst(5 + length)
    }

    return frames
  }
}

private func encodeFrame(kind: String, payload: Data) -> Data? {
  let kindByte: UInt8
  switch kind {
  case "text":
    kindByte = 1
  case "binary":
    kindByte = 2
  default:
    return nil
  }

  let length = UInt32(payload.count).bigEndian
  var header = Data([kindByte])
  withUnsafeBytes(of: length) { bytes in
    header.append(contentsOf: bytes)
  }
  var frame = header
  frame.append(payload)
  return frame
}

private func helloPayload(localPeerId: String) -> Data {
  Data(#"{"type":"hello","peerId":"\#(localPeerId)"}"#.utf8)
}

private extension Data {
  func chunked(maxLength: Int) -> [Data] {
    guard !isEmpty else {
      return [Data()]
    }

    var chunks = [Data]()
    var index = startIndex
    while index < endIndex {
      let nextIndex = self.index(index, offsetBy: maxLength, limitedBy: endIndex) ?? endIndex
      chunks.append(self[index..<nextIndex])
      index = nextIndex
    }
    return chunks
  }
}

class MobileBluetoothPlugin: Plugin, CBPeripheralManagerDelegate {
  private var peripheralManager: CBPeripheralManager?
  private var rxCharacteristic: CBMutableCharacteristic?
  private var txCharacteristic: CBMutableCharacteristic?
  private var localPeerId = ""
  private var desiredActive = false
  private var bluetoothActive = false
  private var serviceRegistrationPending = false
  private var advertisingPending = false
  private var peers = [String: CBCentral]()
  private var readyPeers = Set<String>()
  private var decoders = [String: FrameDecoder]()
  private var pendingSends = [PendingSend]()
  private var pendingStartInvoke: Invoke?

  @objc public func start(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartArgs.self)

    DispatchQueue.main.async {
      self.pendingStartInvoke?.reject("Bluetooth start superseded by a newer request")
      self.pendingStartInvoke = invoke
      self.localPeerId = args.localPeerId
      self.desiredActive = true
      self.resetTransportState(rejectPendingSends: true)
      self.ensurePeripheralManager()
      self.maybeStartPeripheral()
    }
  }

  @objc public func stop(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      self.desiredActive = false
      self.failPendingStart("Bluetooth stopped")
      self.resetTransportState(rejectPendingSends: true)
      invoke.resolve()
    }
  }

  @objc public func send(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SendArgs.self)

    DispatchQueue.main.async {
      guard self.bluetoothActive else {
        invoke.reject("Bluetooth peer not connected")
        return
      }
      guard let payload = Data(base64Encoded: args.payloadBase64) else {
        invoke.reject("Invalid Bluetooth payload")
        return
      }
      self.queueFrame(to: args.address, kind: args.kind, payload: payload, invoke: invoke)
    }
  }

  @objc public func listPeers(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      let peers = self.peers.keys.sorted().map { address in
        PeerSnapshot(address: address, ready: self.readyPeers.contains(address))
      }
      invoke.resolve(PeerSnapshotResponse(peers: peers))
    }
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    DispatchQueue.main.async {
      switch peripheral.state {
      case .poweredOn:
        self.maybeStartPeripheral()
      case .poweredOff:
        self.failActiveSession("Bluetooth is disabled")
      case .unauthorized:
        self.failActiveSession("Bluetooth permission denied")
      case .unsupported:
        self.failActiveSession("Bluetooth LE peripheral is unavailable")
      case .resetting, .unknown:
        self.bluetoothActive = false
      @unknown default:
        self.failActiveSession("Bluetooth state is unavailable")
      }
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    DispatchQueue.main.async {
      guard service.uuid == serviceUUID else {
        return
      }
      self.serviceRegistrationPending = false
      if let error = error {
        self.failActiveSession("Failed to add Bluetooth GATT service: \(error.localizedDescription)")
        return
      }

      self.advertisingPending = true
      peripheral.startAdvertising([
        CBAdvertisementDataServiceUUIDsKey: [serviceUUID]
      ])
    }
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    DispatchQueue.main.async {
      self.advertisingPending = false
      if let error = error {
        self.failActiveSession("Failed to start Bluetooth advertising: \(error.localizedDescription)")
        return
      }

      self.bluetoothActive = true
      self.pendingStartInvoke?.resolve()
      self.pendingStartInvoke = nil
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    DispatchQueue.main.async {
      guard request.characteristic.uuid == txUUID else {
        peripheral.respond(to: request, withResult: .requestNotSupported)
        return
      }

      _ = self.rememberPeer(request.central)
      guard let frame = encodeFrame(kind: "text", payload: helloPayload(localPeerId: self.localPeerId)) else {
        peripheral.respond(to: request, withResult: .unlikelyError)
        return
      }
      guard request.offset <= frame.count else {
        peripheral.respond(to: request, withResult: .invalidOffset)
        return
      }

      request.value = frame.subdata(in: request.offset..<frame.count)
      peripheral.respond(to: request, withResult: .success)
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    DispatchQueue.main.async {
      guard let firstRequest = requests.first else {
        return
      }

      var result: CBATTError.Code = .success
      for request in requests {
        guard request.characteristic.uuid == rxUUID else {
          result = .requestNotSupported
          break
        }

        let address = self.rememberPeer(request.central)
        guard let value = request.value else {
          continue
        }

        let decoder = self.decoders[address] ?? FrameDecoder()
        self.decoders[address] = decoder
        for frame in decoder.append(value) {
          self.triggerFrame(address: address, kind: frame.kind, payload: frame.payload)
        }
      }

      peripheral.respond(to: firstRequest, withResult: result)
    }
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    DispatchQueue.main.async {
      guard characteristic.uuid == txUUID else {
        return
      }

      let address = self.rememberPeer(central)
      self.readyPeers.insert(address)
      self.sendHello(to: address)
      self.triggerAddress("peer-ready", address: address)
    }
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    DispatchQueue.main.async {
      guard characteristic.uuid == txUUID else {
        return
      }

      self.removePeer(address: self.address(for: central), notify: true)
    }
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    DispatchQueue.main.async {
      self.flushPendingSends()
    }
  }

  private func ensurePeripheralManager() {
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self,
        queue: nil,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: true]
      )
    } else {
      peripheralManager?.delegate = self
    }
  }

  private func maybeStartPeripheral() {
    guard desiredActive, let peripheral = peripheralManager else {
      return
    }

    switch peripheral.state {
    case .poweredOn:
      guard !bluetoothActive, !serviceRegistrationPending, !advertisingPending else {
        return
      }

      let rx = CBMutableCharacteristic(
        type: rxUUID,
        properties: [.write, .writeWithoutResponse],
        value: nil,
        permissions: [.writeable]
      )
      let tx = CBMutableCharacteristic(
        type: txUUID,
        properties: [.notify, .read],
        value: nil,
        permissions: [.readable]
      )

      let service = CBMutableService(type: serviceUUID, primary: true)
      service.characteristics = [rx, tx]

      rxCharacteristic = rx
      txCharacteristic = tx
      serviceRegistrationPending = true
      peripheral.add(service)
    case .poweredOff:
      failActiveSession("Bluetooth is disabled")
    case .unauthorized:
      failActiveSession("Bluetooth permission denied")
    case .unsupported:
      failActiveSession("Bluetooth LE peripheral is unavailable")
    case .resetting, .unknown:
      break
    @unknown default:
      failActiveSession("Bluetooth state is unavailable")
    }
  }

  private func failActiveSession(_ message: String) {
    let wasActive = desiredActive || bluetoothActive || serviceRegistrationPending || advertisingPending
    desiredActive = false
    failPendingStart(message)
    if wasActive {
      resetTransportState(rejectPendingSends: true)
    }
  }

  private func failPendingStart(_ message: String) {
    pendingStartInvoke?.reject(message)
    pendingStartInvoke = nil
  }

  private func resetTransportState(rejectPendingSends: Bool) {
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    bluetoothActive = false
    serviceRegistrationPending = false
    advertisingPending = false
    rxCharacteristic = nil
    txCharacteristic = nil
    peers.removeAll()
    readyPeers.removeAll()
    decoders.removeAll()

    if rejectPendingSends {
      rejectAllPendingSends("Bluetooth stopped")
    } else {
      pendingSends.removeAll()
    }
  }

  private func queueFrame(to address: String, kind: String, payload: Data, invoke: Invoke?) {
    guard readyPeers.contains(address), peers[address] != nil else {
      invoke?.reject("Bluetooth peer is not ready for notifications")
      return
    }
    guard let frame = encodeFrame(kind: kind, payload: payload) else {
      invoke?.reject("Invalid Bluetooth frame kind")
      return
    }

    pendingSends.append(
      PendingSend(address: address, chunks: frame.chunked(maxLength: chunkBytes), nextIndex: 0, invoke: invoke)
    )
    flushPendingSends()
  }

  private func flushPendingSends() {
    guard let peripheral = peripheralManager, let txCharacteristic else {
      return
    }

    while !pendingSends.isEmpty {
      var send = pendingSends.removeFirst()
      guard readyPeers.contains(send.address), let central = peers[send.address] else {
        send.invoke?.reject("Bluetooth peer not connected")
        continue
      }

      while send.nextIndex < send.chunks.count {
        let chunk = send.chunks[send.nextIndex]
        if peripheral.updateValue(chunk, for: txCharacteristic, onSubscribedCentrals: [central]) {
          send.nextIndex += 1
        } else {
          pendingSends.insert(send, at: 0)
          return
        }
      }

      send.invoke?.resolve()
    }
  }

  private func sendHello(to address: String) {
    queueFrame(to: address, kind: "text", payload: helloPayload(localPeerId: localPeerId), invoke: nil)
  }

  private func rememberPeer(_ central: CBCentral) -> String {
    let address = self.address(for: central)
    if peers[address] == nil {
      peers[address] = central
      decoders[address] = FrameDecoder()
      triggerAddress("peer-connected", address: address)
    } else {
      peers[address] = central
    }
    return address
  }

  private func removePeer(address: String, notify: Bool) {
    peers.removeValue(forKey: address)
    readyPeers.remove(address)
    decoders.removeValue(forKey: address)
    rejectPendingSends(for: address, message: "Bluetooth peer disconnected")
    if notify {
      triggerAddress("peer-disconnected", address: address)
    }
  }

  private func rejectPendingSends(for address: String, message: String) {
    var retained = [PendingSend]()
    for send in pendingSends {
      if send.address == address {
        send.invoke?.reject(message)
      } else {
        retained.append(send)
      }
    }
    pendingSends = retained
  }

  private func rejectAllPendingSends(_ message: String) {
    for send in pendingSends {
      send.invoke?.reject(message)
    }
    pendingSends.removeAll()
  }

  private func address(for central: CBCentral) -> String {
    central.identifier.uuidString
  }

  private func triggerAddress(_ event: String, address: String) {
    try? trigger(event, data: AddressEvent(address: address))
  }

  private func triggerFrame(address: String, kind: String, payload: Data) {
    try? trigger(
      "frame",
      data: FrameEvent(address: address, kind: kind, payloadBase64: payload.base64EncodedString())
    )
  }
}

@_cdecl("init_plugin_mobile_bluetooth")
func initPlugin() -> Plugin {
  MobileBluetoothPlugin()
}
