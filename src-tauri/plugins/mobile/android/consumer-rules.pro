# ML Kit 从清单读取注册器类名，再反射调用无参构造函数。
# R8 完整优化模式不会因保留类名而自动保留构造函数；缺失时组件注册失败并在扫码取帧时崩溃。
-keep class com.google.mlkit.** implements com.google.firebase.components.ComponentRegistrar {
    public <init>();
}
