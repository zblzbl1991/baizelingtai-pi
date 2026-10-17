# Independent Office workbook fixtures

`preview.xls` is the Harness-authored synthetic `Office preview 中文文档`
document exported with LibreOffice 26.8.0.3's Excel 97 filter. Source:
<https://github.com/deepseek-harness/libreoffice-kit/tree/main/test/fixtures>.
The upstream MIT license is retained in `LICENSE`.
SHA256: `311df8fcb797cfeffb552f254a054976ab61611d4a2cf68cd11f3ae7e2a73d37`.

`test/office-workbook-fixtures.cjs` independently serializes OPC XML/ZIP and
a BIFF5/CFB fixture. It uses Node zlib and literal expected contents, never the
workbook parser under test. Its codepage 936 bytes `D6 D0 CE C4` mean `中文`.
These are parsing and rendering samples, not evidence of full Excel fidelity.
