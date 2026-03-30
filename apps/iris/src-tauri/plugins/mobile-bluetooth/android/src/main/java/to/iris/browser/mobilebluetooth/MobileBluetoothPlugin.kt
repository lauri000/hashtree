package to.iris.browser.mobilebluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray

private const val TAG = "MobileBluetoothPlugin"
private val SERVICE_UUID: UUID = UUID.fromString("f18ef5f6-b7ee-4f40-b869-10a2d4f35932")
private val RX_UUID: UUID = UUID.fromString("0bb5f5c9-6369-4511-a84f-4d4c14d8f8d4")
private val TX_UUID: UUID = UUID.fromString("4ec9c0c2-97c6-4f46-9fd1-927d699b2f6d")
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
private const val CHUNK_BYTES: Int = 180
private const val UNREADY_DISCONNECT_DELAY_MS: Long = 2500

@InvokeArg
class StartArgs {
    lateinit var localPeerId: String
}

@InvokeArg
class SendArgs {
    lateinit var address: String
    lateinit var kind: String
    lateinit var payloadBase64: String
}

private data class DecodedFrame(val kind: String, val payload: ByteArray)

private data class QueuedFrame(val address: String, val kind: String, val payloadBase64: String)

private class FrameDecoder {
    private val buffer = ArrayList<Byte>()

    fun append(chunk: ByteArray): List<DecodedFrame> {
        val frames = mutableListOf<DecodedFrame>()
        chunk.forEach { buffer.add(it) }
        while (buffer.size >= 5) {
            val header = ByteBuffer.wrap(byteArrayOf(buffer[1], buffer[2], buffer[3], buffer[4]))
            val len = header.int
            if (buffer.size < 5 + len) {
                break
            }
            val kind = buffer[0].toInt()
            val payload = ByteArray(len)
            for (i in 0 until len) {
                payload[i] = buffer[5 + i]
            }
            repeat(5 + len) { buffer.removeAt(0) }
            frames.add(
                DecodedFrame(
                    if (kind == 1) "text" else "binary",
                    payload,
                )
            )
        }
        return frames
    }
}

private fun encodeFrame(kind: String, payload: ByteArray): ByteArray {
    val kindByte: Byte = if (kind == "text") 1 else 2
    val header = ByteBuffer.allocate(5)
    header.put(kindByte)
    header.putInt(payload.size)
    return header.array() + payload
}

private fun helloPayload(localPeerId: String): ByteArray {
    return """{"type":"hello","peerId":"$localPeerId"}""".toByteArray(StandardCharsets.UTF_8)
}

@TauriPlugin
class MobileBluetoothPlugin(private val activity: android.app.Activity) : Plugin(activity) {
    private val appContext: Context = activity.applicationContext
    private val bluetoothManager =
        appContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager.adapter
    private val advertiser: BluetoothLeAdvertiser? = bluetoothAdapter?.bluetoothLeAdvertiser

    private var gattServer: BluetoothGattServer? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null
    private var localPeerId: String = ""
    private val devices = ConcurrentHashMap<String, BluetoothDevice>()
    private val subscribed = ConcurrentHashMap.newKeySet<String>()
    private val decoders = ConcurrentHashMap<String, FrameDecoder>()
    private val drainedFrames = ConcurrentLinkedQueue<QueuedFrame>()
    private val pendingDisconnects = ConcurrentHashMap<String, Runnable>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val advertiseCallback = object : AdvertiseCallback() {}
    private var bluetoothActive = false

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        localPeerId = args.localPeerId
        Log.i(TAG, "start invoked for peer ${args.localPeerId}")
        try {
            stopInternal()
            if (bluetoothAdapter == null || advertiser == null) {
                Log.w(TAG, "Bluetooth LE advertiser is unavailable")
                invoke.reject("Bluetooth LE advertiser is unavailable")
                return
            }
            if (!bluetoothAdapter.isEnabled) {
                Log.w(TAG, "Bluetooth is disabled")
                invoke.reject("Bluetooth is disabled")
                return
            }

            val serviceAdded = CountDownLatch(1)
            var serviceAddedOk = false

            val serverCallback = object : BluetoothGattServerCallback() {
                override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                    val address = device.address
                    if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                        Log.d(TAG, "BLE device connected: $address")
                        devices[address] = device
                        decoders[address] = FrameDecoder()
                        scheduleUnreadyDisconnect(address, device, "startup-timeout")
                        triggerAddress("peer-connected", address)
                    } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                        Log.d(TAG, "BLE device disconnected: $address")
                        cancelPendingDisconnect(address)
                        devices.remove(address)
                        subscribed.remove(address)
                        decoders.remove(address)
                        triggerAddress("peer-disconnected", address)
                    }
                }

                override fun onCharacteristicReadRequest(
                    device: BluetoothDevice,
                    requestId: Int,
                    offset: Int,
                    characteristic: BluetoothGattCharacteristic,
                ) {
                    if (characteristic.uuid == TX_UUID) {
                        val frame = encodeFrame("text", helloPayload(localPeerId))
                        val value =
                            if (offset in 0 until frame.size) frame.copyOfRange(offset, frame.size) else ByteArray(0)
                        Log.d(TAG, "Serving hello read to ${device.address} (${value.size} bytes, offset=$offset)")
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                    } else {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                    }
                }

                override fun onCharacteristicWriteRequest(
                    device: BluetoothDevice,
                    requestId: Int,
                    characteristic: BluetoothGattCharacteristic,
                    preparedWrite: Boolean,
                    responseNeeded: Boolean,
                    offset: Int,
                    value: ByteArray,
                ) {
                    if (characteristic.uuid == RX_UUID) {
                        Log.d(TAG, "Received BLE write from ${device.address} (${value.size} bytes)")
                        val decoder = decoders.computeIfAbsent(device.address) { FrameDecoder() }
                        decoder.append(value).forEach { frame ->
                            triggerFrame(device.address, frame.kind, frame.payload)
                        }
                    }
                    if (responseNeeded) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                    }
                }

                override fun onDescriptorWriteRequest(
                    device: BluetoothDevice,
                    requestId: Int,
                    descriptor: BluetoothGattDescriptor,
                    preparedWrite: Boolean,
                    responseNeeded: Boolean,
                    offset: Int,
                    value: ByteArray,
                ) {
                    if (descriptor.uuid == CCCD_UUID && value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                        Log.d(TAG, "Notifications enabled for ${device.address}")
                        subscribed.add(device.address)
                        cancelPendingDisconnect(device.address)
                        sendHello(device)
                        triggerAddress("peer-ready", device.address)
                    }
                    if (responseNeeded) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                    }
                }

                override fun onServiceAdded(status: Int, service: BluetoothGattService) {
                    if (service.uuid != SERVICE_UUID) {
                        return
                    }
                    serviceAddedOk = status == BluetoothGatt.GATT_SUCCESS
                    Log.i(TAG, "Service add callback for ${service.uuid} status=$status")
                    serviceAdded.countDown()
                }
            }

            gattServer = bluetoothManager.openGattServer(appContext, serverCallback)
            if (gattServer == null) {
                Log.e(TAG, "Failed to open Bluetooth GATT server")
                invoke.reject("Failed to open Bluetooth GATT server")
                return
            }
            val rx = BluetoothGattCharacteristic(
                RX_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            )
            val tx = BluetoothGattCharacteristic(
                TX_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
            tx.addDescriptor(
                BluetoothGattDescriptor(
                    CCCD_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
                )
            )
            txCharacteristic = tx
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            service.addCharacteristic(rx)
            service.addCharacteristic(tx)
            if (gattServer?.addService(service) != true) {
                Log.e(TAG, "Failed to queue Bluetooth GATT service")
                invoke.reject("Failed to add Bluetooth GATT service")
                return
            }
            if (!serviceAdded.await(3, TimeUnit.SECONDS)) {
                Log.e(TAG, "Timed out waiting for Bluetooth GATT service registration")
                invoke.reject("Timed out waiting for Bluetooth GATT service registration")
                return
            }
            if (!serviceAddedOk) {
                Log.e(TAG, "Bluetooth GATT service registration failed")
                invoke.reject("Bluetooth GATT service registration failed")
                return
            }
            Log.i(TAG, "Bluetooth GATT service registered, starting advertising")

            advertiser.startAdvertising(
                AdvertiseSettings.Builder()
                    .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                    .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                    .setConnectable(true)
                    .build(),
                AdvertiseData.Builder()
                    .addServiceUuid(ParcelUuid(SERVICE_UUID))
                    .setIncludeDeviceName(false)
                    .build(),
                advertiseCallback,
            )

            bluetoothActive = true
            Log.i(TAG, "Bluetooth advertising and GATT server started")
            invoke.resolve()
        } catch (error: SecurityException) {
            Log.e(TAG, "Bluetooth permission missing", error)
            invoke.reject("Bluetooth permission missing: ${error.message}")
        } catch (error: Exception) {
            Log.e(TAG, "Failed to start Bluetooth server", error)
            invoke.reject("Failed to start Bluetooth server: ${error.message}")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        Log.i(TAG, "stop invoked")
        bluetoothActive = false
        stopInternal()
        invoke.resolve()
    }

    @Command
    fun send(invoke: Invoke) {
        val args = invoke.parseArgs(SendArgs::class.java)
        val device = devices[args.address]
        val characteristic = txCharacteristic
        val server = gattServer
        if (device == null || characteristic == null || server == null) {
            invoke.reject("Bluetooth peer not connected")
            return
        }
        if (!subscribed.contains(args.address)) {
            invoke.reject("Bluetooth peer is not ready for notifications")
            return
        }
        val payload = Base64.decode(args.payloadBase64, Base64.DEFAULT)
        val frame = encodeFrame(args.kind, payload)
        for (chunk in frame.asList().chunked(CHUNK_BYTES)) {
            if (!notifyCharacteristicChanged(server, device, characteristic, chunk.toByteArray())) {
                invoke.reject("Failed to notify Bluetooth peer")
                return
            }
        }
        invoke.resolve()
    }

    @Command
    fun pollTransport(invoke: Invoke) {
        Log.i(TAG, "pollTransport returning ${devices.size} device(s); ready=${subscribed.size}")
        invoke.resolve(buildTransportPollPayload())
    }

    override fun onDestroy() {
        super.onDestroy()
        bluetoothActive = false
        stopInternal()
    }

    private fun sendHello(device: BluetoothDevice) {
        val characteristic = txCharacteristic ?: return
        val server = gattServer ?: return
        val frame = encodeFrame("text", helloPayload(localPeerId))
        for (chunk in frame.asList().chunked(CHUNK_BYTES)) {
            notifyCharacteristicChanged(server, device, characteristic, chunk.toByteArray())
        }
    }

    private fun triggerAddress(event: String, address: String) {
        val payload = JSObject()
        payload.put("address", address)
        trigger(event, payload)
    }

    private fun triggerFrame(address: String, kind: String, payloadBytes: ByteArray) {
        val payloadBase64 = Base64.encodeToString(payloadBytes, Base64.NO_WRAP)
        drainedFrames.add(QueuedFrame(address, kind, payloadBase64))
    }

    private fun stopInternal() {
        Log.d(TAG, "Stopping Bluetooth advertiser and GATT server")
        disconnectUnreadyDevices("stop")
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: Exception) {}
        try {
            gattServer?.close()
        } catch (_: Exception) {}
        gattServer = null
        txCharacteristic = null
        devices.clear()
        subscribed.clear()
        decoders.clear()
        drainedFrames.clear()
        pendingDisconnects.values.forEach { mainHandler.removeCallbacks(it) }
        pendingDisconnects.clear()
    }

    private fun buildTransportPollPayload(): JSObject {
        val payload = JSObject()
        payload.put("peers", buildPeerSnapshots())
        payload.put("frames", drainQueuedFrames())
        return payload
    }

    private fun buildPeerSnapshots(): JSONArray {
        val peers = JSONArray()
        devices.keys.sorted().forEach { address ->
            val peer = JSObject()
            peer.put("address", address)
            peer.put("ready", subscribed.contains(address))
            peers.put(peer)
        }
        return peers
    }

    private fun drainQueuedFrames(): JSONArray {
        val frames = JSONArray()
        while (true) {
            val frame = drainedFrames.poll() ?: break
            val payload = JSObject()
            payload.put("address", frame.address)
            payload.put("kind", frame.kind)
            payload.put("payloadBase64", frame.payloadBase64)
            frames.put(payload)
        }
        return frames
    }

    private fun disconnectUnreadyDevices(reason: String) {
        val server = gattServer ?: return
        devices.entries
            .sortedBy { it.key }
            .forEach { (address, device) ->
                if (subscribed.contains(address)) {
                    return@forEach
                }
                Log.i(TAG, "Disconnecting BLE device $address to recover clean startup ($reason)")
                try {
                    server.cancelConnection(device)
                } catch (error: Exception) {
                    Log.w(TAG, "Failed to cancel BLE connection for $address", error)
                }
            }
    }

    private fun scheduleUnreadyDisconnect(address: String, device: BluetoothDevice, reason: String) {
        cancelPendingDisconnect(address)
        val disconnectTask =
            Runnable {
                if (!bluetoothActive || subscribed.contains(address)) {
                    pendingDisconnects.remove(address)
                    return@Runnable
                }
                Log.i(TAG, "Disconnecting BLE device $address after readiness timeout ($reason)")
                try {
                    gattServer?.cancelConnection(device)
                } catch (error: Exception) {
                    Log.w(TAG, "Failed to cancel BLE connection for $address", error)
                } finally {
                    pendingDisconnects.remove(address)
                }
            }
        pendingDisconnects[address] = disconnectTask
        mainHandler.postDelayed(disconnectTask, UNREADY_DISCONNECT_DELAY_MS)
    }

    private fun cancelPendingDisconnect(address: String) {
        pendingDisconnects.remove(address)?.let { pending ->
            mainHandler.removeCallbacks(pending)
        }
    }

    @Suppress("DEPRECATION")
    private fun notifyCharacteristicChanged(
        server: BluetoothGattServer,
        device: BluetoothDevice,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
    ): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, characteristic, false, value) ==
                BluetoothStatusCodes.SUCCESS
        } else {
            characteristic.value = value
            server.notifyCharacteristicChanged(device, characteristic, false)
        }
    }
}
