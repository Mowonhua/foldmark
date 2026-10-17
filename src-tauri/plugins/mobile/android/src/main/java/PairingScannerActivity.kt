package app.foldmark.mobilebridge

import android.content.Context
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.ViewfinderView

/** 竖屏配对扫码页。解码、相机释放及取消结果仍由 CaptureActivity 负责，控件避开系统栏。 */
class PairingScannerActivity : CaptureActivity() {
    private var torchOn = false
    private lateinit var scanner: DecoratedBarcodeView

    override fun initializeContent(): DecoratedBarcodeView {
        setContentView(R.layout.foldmark_scanner)
        scanner = findViewById(R.id.zxing_barcode_scanner)
        return scanner
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        val controls = findViewById<View>(R.id.scanner_controls)
        ViewCompat.setOnApplyWindowInsetsListener(controls) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(controls)
        findViewById<ImageButton>(R.id.scanner_close).setOnClickListener { finish() }
        val torch = findViewById<Button>(R.id.scanner_torch)
        torch.visibility = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) View.VISIBLE else View.GONE
        torch.setOnClickListener {
            torchOn = !torchOn
            if (torchOn) scanner.setTorchOn() else scanner.setTorchOff()
            torch.text = if (torchOn) "关闭手电筒" else "打开手电筒"
            torch.isSelected = torchOn
        }
    }
}

/** 引导框与解码区域使用同一 framingRect；不绘制红色扫描线或解码点，保持取景清晰。 */
class PairingViewfinder(context: Context, attrs: AttributeSet?) : ViewfinderView(context, attrs) {
    override fun onDraw(canvas: Canvas) {
        refreshSizes()
        val frame = framingRect ?: run { postInvalidateDelayed(80); return }
        val density = resources.displayMetrics.density
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(150, 0, 0, 0)
        canvas.drawRect(0f, 0f, width.toFloat(), frame.top.toFloat(), paint)
        canvas.drawRect(0f, frame.bottom.toFloat(), width.toFloat(), height.toFloat(), paint)
        canvas.drawRect(0f, frame.top.toFloat(), frame.left.toFloat(), frame.bottom.toFloat(), paint)
        canvas.drawRect(frame.right.toFloat(), frame.top.toFloat(), width.toFloat(), frame.bottom.toFloat(), paint)
        paint.color = Color.WHITE; paint.style = Paint.Style.STROKE
        paint.strokeWidth = 3 * density; paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
        val length = 24 * density
        val left = frame.left.toFloat(); val right = frame.right.toFloat()
        val top = frame.top.toFloat(); val bottom = frame.bottom.toFloat()
        val corners = Path().apply {
            moveTo(left, top + length); lineTo(left, top); lineTo(left + length, top)
            moveTo(right - length, top); lineTo(right, top); lineTo(right, top + length)
            moveTo(left, bottom - length); lineTo(left, bottom); lineTo(left + length, bottom)
            moveTo(right - length, bottom); lineTo(right, bottom); lineTo(right, bottom - length)
        }
        canvas.drawPath(corners, paint)
    }
}
