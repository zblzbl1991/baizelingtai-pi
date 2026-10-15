banner.png 的源。重建：

    chrome --headless --no-proxy-server --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=1280,400 --screenshot=../banner.png "file://$(pwd)/banner.html"

samples.png：notice、qingshi、xinhan、jiyao 四份样张经 Word 导出 PDF 后的首页（90 dpi）拼图。
出图前设 `GONGWEN_FONT_TITLE="Songti SC Black"`（本机没装方正小标宋时），否则标题回退成宋体。

社交预览图（GitHub Settings → Social preview，2:1）的源是 social.html，不入库，要时重出：

    chrome --headless --no-proxy-server --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=1280,640 --screenshot="$HOME/Desktop/gongwen-kit-social-preview.png" "file://$(pwd)/social.html"

full.png、qiye.png：docs/样张/ 里对应 PDF 的逐页拼图（100 dpi）。docs/样张/ 的 PDF 由 Word 导出，
同样设 `GONGWEN_FONT_TITLE="Songti SC Black"`。

compare.png：compare.html 的截图，窗口 1600×1560，2 倍。改动对比内容先重核来源，改核对日期。
