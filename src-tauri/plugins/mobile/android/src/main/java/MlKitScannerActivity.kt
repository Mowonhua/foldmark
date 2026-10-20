package app.taskrail.mobilebridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.Bundle
import android.util.AttributeSet
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 配对扫码页：CameraX 连续取帧交给 ML Kit 离线识别，识别到二维码就用原始文本结束页面。
 * ML Kit 分析整幅预览画面，取景框只是视觉引导，二维码不必正好落在框内。
 */
class MlKitScannerActivity : AppCompatActivity() {
    companion object {
        /** MobilePlugin 用同一个键取回扫码结果。 */
        const val RESULT = "SCAN_RESULT"
        private const val REQUEST_CAMERA = 4101
    }

    private lateinit var preview: PreviewView
    private lateinit var torch: Button
    private val analysis = Executors.newSingleThreadExecutor()
    private val scanner: BarcodeScanner by lazy {
        BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
    }
    /** 解码回调与用户操作可能同时到达，只允许第一个结果结束页面。 */
    private val delivered = AtomicBoolean(false)
    private var camera: Camera? = null
    private var torchOn = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(R.layout.taskrail_scanner)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        preview = findViewById(R.id.scanner_preview)
        val controls = findViewById<View>(R.id.scanner_controls)
        ViewCompat.setOnApplyWindowInsetsListener(controls) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(controls)
        findViewById<ImageButton>(R.id.scanner_close).setOnClickListener { finish() }
        torch = findViewById(R.id.scanner_torch)
        torch.visibility = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) View.VISIBLE else View.GONE
        torch.setOnClickListener {
            torchOn = !torchOn
            camera?.cameraControl?.enableTorch(torchOn)
            torch.text = if (torchOn) "关闭手电筒" else "打开手电筒"
            torch.isSelected = torchOn
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) start()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != REQUEST_CAMERA) return
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) start() else finish()
    }

    private fun start() {
        val provider = ProcessCameraProvider.getInstance(this)
        provider.addListener({
            runCatching {
                val instance = provider.get()
                val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val analysisUseCase = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysisUseCase.setAnalyzer(analysis, ::analyze)
                instance.unbindAll()
                camera = instance.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysisUseCase)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @ExperimentalGetImage
    private fun analyze(proxy: ImageProxy) {
        val media = proxy.image
        if (media == null) { proxy.close(); return }
        val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        scanner.process(image)
            .addOnSuccessListener { found -> found.firstNotNullOfOrNull { it.rawValue }?.let(::deliver) }
            .addOnCompleteListener { proxy.close() }
    }

    private fun deliver(value: String) {
        if (!delivered.compareAndSet(false, true)) return
        setResult(RESULT_OK, Intent().putExtra(RESULT, value))
        finish()
    }

    override fun onDestroy() {
        analysis.shutdown()
        scanner.close()
        super.onDestroy()
    }
}

/** 取景框只负责视觉引导与遮罩，不裁剪识别区域：整幅预览都参与解码。 */
class ScannerFrame(context: Context, attrs: AttributeSet?) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val side = minOf(width * 0.76f, height * 0.5f, 320f * density)
        val left = (width - side) / 2f
        val top = (height - side) / 2f
        val right = left + side
        val bottom = top + side
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(150, 0, 0, 0)
        canvas.drawRect(0f, 0f, width.toFloat(), top, paint)
        canvas.drawRect(0f, bottom, width.toFloat(), height.toFloat(), paint)
        canvas.drawRect(0f, top, left, bottom, paint)
        canvas.drawRect(right, top, width.toFloat(), bottom, paint)
        paint.style = Paint.Style.STROKE
        paint.color = Color.WHITE
        paint.strokeWidth = 3 * density
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        val length = 24 * density
        val corners = Path().apply {
            moveTo(left, top + length); lineTo(left, top); lineTo(left + length, top)
            moveTo(right - length, top); lineTo(right, top); lineTo(right, top + length)
            moveTo(left, bottom - length); lineTo(left, bottom); lineTo(left + length, bottom)
            moveTo(right - length, bottom); lineTo(right, bottom); lineTo(right, bottom - length)
        }
        canvas.drawPath(corners, paint)
    }
}
