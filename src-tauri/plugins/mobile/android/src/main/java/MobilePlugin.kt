package app.taskrail.mobilebridge

import android.Manifest
import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/** 扫码解码随 APK 提供；组播锁只在前台同步时持有，离开应用立即释放。 */
@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
    Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "network")
])
class MobilePlugin(private val activity: Activity) : Plugin(activity) {
    private var multicast: WifiManager.MulticastLock? = null
    private val updater = AndroidUpdater(activity) { trigger("updateProgress", it) }

    @Command fun checkUpdate(invoke: Invoke) { updater.check(invoke) }
    @Command fun downloadUpdate(invoke: Invoke) { updater.download(invoke) }
    @Command fun installUpdate(invoke: Invoke) { updater.install(invoke) }
    @Command fun closeUpdate(invoke: Invoke) { updater.close(); invoke.resolve() }
    private fun needsNetworkPermission(): Boolean = Build.VERSION.SDK_INT >= 37 && activity.applicationInfo.targetSdkVersion >= 37

    @Command
    fun prepare(invoke: Invoke) {
        if (needsNetworkPermission() && getPermissionState("network") != PermissionState.GRANTED) {
            requestPermissionForAlias("network", invoke, "networkPermission")
        } else activate(invoke)
    }

    @PermissionCallback
    fun networkPermission(invoke: Invoke) { activate(invoke) }

    /** 自动重试只能检查权限，不能在每轮同步中反复弹出权限请求。 */
    @Command
    fun activate(invoke: Invoke) {
        if (needsNetworkPermission() && getPermissionState("network") != PermissionState.GRANTED) {
            invoke.reject("局域网权限已拒绝，请在系统设置中允许后重试")
            return
        }
        try {
            if (multicast?.isHeld != true) {
                val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                multicast = wifi.createMulticastLock("taskrail-sync").apply { setReferenceCounted(false); acquire() }
            }
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message ?: "无法启用局域网发现") }
    }

    @Command
    fun scan(invoke: Invoke) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", invoke, "cameraPermission")
            return
        }
        val options = ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setCaptureActivity(PairingScannerActivity::class.java).setPrompt("")
            .setBeepEnabled(false).setOrientationLocked(false)
        startActivityForResult(invoke, ScanContract().createIntent(activity, options), "scanResult")
    }

    @PermissionCallback
    fun cameraPermission(invoke: Invoke) {
        if (getPermissionState("camera") == PermissionState.GRANTED) scan(invoke)
        else invoke.reject("相机权限已拒绝，可使用手动配对")
    }

    @ActivityCallback
    fun scanResult(invoke: Invoke, result: ActivityResult) {
        val content = ScanContract().parseResult(result.resultCode, result.data).contents
        val response = JSObject()
        response.put("content", content)
        invoke.resolve(response)
    }

    override fun onPause(activity: AppCompatActivity) {
        if (multicast?.isHeld == true) multicast?.release()
    }

    override fun onDestroy(activity: AppCompatActivity) { updater.destroy() }
}
