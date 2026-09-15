# chataxi v0.4.17 应用图标交付

本次把确认后的 chataxi 图标接入 happ 安装清单并生成正式发布包。

运行图标位于 `app/assets/icon.webp`，尺寸为 512×512。它由完整的 1024×1024 高清最终稿使用 Lanczos 等比例缩放后，以无损 WebP 保存；没有裁切、重新取景或改变构图，黄色圆角底和图案四周的安全边距均按原比例保留。相较约 822 KB 的高清 PNG，运行资源约 145 KB。

Hermit 根据 `hermit.json.icon` 读取该文件。由于输入本身是正方形，`IconProcessor` 的居中裁切是无操作，只会把完整画布缩放为 192×192 PNG，用于应用卡片和桌面入口。页面 favicon 使用同一资源。

版本号为 0.4.17，版本代码为 32。发布归档必须包含图标文件，且 `hermit-install.json` 的包路径和 SHA-256 必须与 `release/chataxi-v0.4.17.zip` 一致。
