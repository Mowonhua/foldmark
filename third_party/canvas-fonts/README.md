# Taskrail Sans

`LiberationSans-Regular.woff2` 基于官方 Liberation Sans 2.1.5 Regular。原始 TTF 来自 [Liberation Fonts 2.1.5 发布页](https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5)提供的[字体压缩包](https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz)。字体使用 [SIL Open Font License 1.1](../../docs/licenses/canvas/Liberation-OFL.txt)。

转换使用 FontTools 4.61.0。字体保留原始字形、字符映射、字宽、垂直度量、hinting、版权、商标和许可声明，不裁剪字符。转换关闭时间戳重算。

为避免使用上游的保留字体名，字体内部名称改为：

| 字段 | 值 |
| --- | --- |
| Family，name ID 1 | `Taskrail Sans` |
| Unique ID，name ID 3 | `TaskrailSans-Regular;2.1.5;Taskrail` |
| Full name，name ID 4 | `Taskrail Sans Regular` |
| PostScript name，name ID 6 | `TaskrailSans-Regular` |

其他存在的家族名字段同样改为 Taskrail 名称。文件路径保持 `canvas-assets/fonts/Liberation/LiberationSans-Regular.woff2`，用于兼容 Excalidraw 的资源地址。文件名不代表字体内部名称。

转换后的 2,620 个字形轮廓、完整 `hmtx` 字宽表、`cmap` 字符映射及 hinting 表均与原始 TTF 逐项一致。相较 Excalidraw 附带的 1.05 版本，ASCII 字宽、`unitsPerEm`、`hhea` 和 `OS/2` 垂直度量一致。658 个共同字符中有两项字宽不同：

| 字符 | 1.05 字宽 | 2.1.5 字宽 |
| --- | --- | --- |
| `U+00B7`，中点 | 569 | 682 |
| `U+2012`，数字横线 | 682 | 1139 |

字宽单位为字体单位，每 em 为 2,048 单位。

[LiberationSans-Regular.source.json](LiberationSans-Regular.source.json) 记录压缩包、原始 TTF 和输出 WOFF2 的 SHA-256，以及转换和度量比较结果。构建只分发本目录的替代字体，不分发依赖包中的旧版文件。

从压缩包取得 `liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf` 后，可用以下 Python 代码复现转换：

```python
from fontTools.ttLib import TTFont

font = TTFont("LiberationSans-Regular.ttf", recalcTimestamp=False)
names = {
    1: "Taskrail Sans",
    3: "TaskrailSans-Regular;2.1.5;Taskrail",
    4: "Taskrail Sans Regular",
    6: "TaskrailSans-Regular",
    16: "Taskrail Sans",
    18: "Taskrail Sans Regular",
    21: "Taskrail Sans",
    25: "TaskrailSans",
}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.flavor = "woff2"
font.save("LiberationSans-Regular.woff2")
```
