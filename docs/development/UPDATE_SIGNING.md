# 更新清单签名工具

本页描述维护者本机显式运行的离线工具 `scripts/update-signing.cjs`。它不联网、不读取环境变量中的密码、不会自行发布或操作业务数据。包构建与签名分开进行；此工具已经实现密钥生成、准确归档签名及授权换钥，但不表示便携包接线、整套启动器升级或实机发布验收已经完成。协议及首次信任见[版本与更新](../UPDATES.md#发布者签名与首次信任)。

## 生成密钥

准备源码或发行包以外的私钥目录，以及单独的公钥交付目录，两个父目录必须已经存在。以下为路径示例：

```powershell
node scripts/update-signing.cjs keygen --private-key C:\ReleaseKeys\publisher.pem --trust-file C:\ReleasePublic\update-trust.json --key-id release-2026
```

工具交互读取两次隐藏口令，至少 12 个字符；口令不进入参数、环境变量、输出或 readline 历史。私钥使用 AES-256-CBC 加密的 Ed25519 PKCS8 PEM；公钥另存为 `schemaVersion:1` 信任文档，只包含 keyId 与 PEM SPKI 公钥。私钥输出拒绝放进应用源码/程序目录。两个输出均以独占方式创建，已有文件拒绝覆盖。文件使用项目统一私密文件创建接口，POSIX 为 0600，Windows 使用原生 DACL；不改变父目录或安装证书。

通过独立可信渠道交付 `update-trust.json`，安装在稳定安装根的 `config/update-trust.json`。候选包或远程清单不能自行授权第一次信任。维护者负责保管加密私钥及独立恢复材料，私钥不能进入源码、更新仓库、便携归档或日志；测试只使用临时合成密钥。

非交互自动化可显式增加 `--passphrase-stdin`，从标准输入读取一行口令并以 EOF 结束；此模式不会二次确认。不要在命令行、Shell 历史或脚本明文中拼入口令。缺少交互终端且未显式指定该参数时工具拒绝执行；不支持 `--passphrase` 或密码环境变量。

## 签署准确发布清单

先准备准确应用 ZIP、无签名的 v1 更新清单，以及持有受信公钥的本地根目录。下面的 `--trust-root` 表示该目录包含 `config/update-trust.json`，不要求服务正在运行。

```powershell
node scripts/update-signing.cjs sign --private-key C:\ReleaseKeys\publisher.pem --key-id release-2026 --trust-root C:\ReleaseTrust --manifest C:\ReleasePublic\unsigned.json --archive C:\ReleasePublic\app.zip --feed https://updates.example/updates/latest.json --output C:\ReleasePublic\latest.json
```

清单字段沿用已有 `schemaVersion:1` 协议；`--feed` 必须是实际分发清单地址，相对 package/release 链接由该地址解析并遵守同源限制。工具在读取口令之前核对清单格式、ZIP 的准确字节数和 SHA256，签名前后使用安全读取重新核对归档及清单，验证所用私钥确实对应本地授权公钥，然后向新文件写入包含 `signature` 的完整清单。归档上限为 1 GiB，输入清单上限为 64 KiB。它核对整个 ZIP 的字节与哈希，不代替打包阶段的 ZIP 路径/逐文件清单验收或候选程序验收。

已签名输入、字节数/哈希不符、源清单在等待口令时变化、不可信密钥、错误口令及已有输出都会失败；已有输出不覆盖。失败只显示固定诊断，不打印输入、密码、私钥、OpenSSL 错误或堆栈，不留下冒充成功的签名产物。输出写入及完整性复核失败时，仅清理仍可确认由本次创建的对象；身份不明则保留现场，不能据此认定发布成功。成功后仍需按发布流程验收并上传准确 ZIP 和清单，本工具不执行上传。

## 授权换钥

先在独立目录生成下一组密钥/公钥。当前受信私钥为新的信任列表签署提案，不会立即修改安装：

```powershell
node scripts/update-signing.cjs rotation-sign --private-key C:\ReleaseKeys\publisher.pem --key-id release-2026 --installation-root C:\BaizeInstall --next-trust C:\ReleasePublic\next-update-trust.json --output C:\ReleasePublic\rotation.json
```

提案绑定当前信任文件的准确 SHA256、下一组 keyId/公钥和旧签名者。工具验证下一组信任格式、旧密钥授权以及签名前后的输入一致性；提案输出也拒绝覆盖。

在独立维护窗口正常退出使用该安装的程序后，维护者显式应用提案：

```powershell
node scripts/update-signing.cjs rotation-apply --installation-root C:\BaizeInstall --rotation C:\ReleasePublic\rotation.json
```

应用操作先取得与正常启动相同的原安装锁，再核对当前信任和提案、重新验签，原子替换该安装的 `config/update-trust.json`，最后释放锁。它不需要私钥或口令，也不接受绕过验证参数。存在其他安装所有者、未知新签名者、内容变化或轮换重放时失败；不会强行停止程序或重复执行。此命令是唯一显式替换既有文件的操作，普通生成/签署命令都不覆盖输出。

密钥丢失或泄露时，陌生远程密钥不能授权恢复，应停止签名发布并通过独立可信渠道重新交付信任。若命令在替换后中断或报告结果不明，先核对本地信任文件及提案的 previousTrustSha256，不自动重放。

## 验证范围

公开 CLI 与更新检查专项见 `test/update-signing-cli.test.js`、`test/pi-update-signatures.test.js`。测试只在临时目录使用合成密钥，通过真实子进程验证加密私钥、准确包绑定、错误口令/输入拒绝、不覆盖输出、信任轮换和安装锁冲突；没有访问真实私钥、Provider 或运行中的安装。实际交付还需集成分支的完整便携包验收。
