# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 打包配置：单文件、无控制台窗口（GUI）
# 构建：pyinstaller build.spec --noconfirm  →  dist/pdf_toc.exe

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs

# 收集 RapidOCR 的模型(.onnx)与配置(.yaml)数据文件
datas, binaries, hiddenimports = collect_all("rapidocr_onnxruntime")
# 兜底收集 onnxruntime / opencv 的动态库（含 onnxruntime_providers_shared.dll）
binaries += collect_dynamic_libs("onnxruntime")
binaries += collect_dynamic_libs("cv2")

a = Analysis(
    ["pdf_toc.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch", "tensorflow", "paddle", "paddlepaddle",
        "pytest", "tkinterdnd2",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="pdf_toc",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,                     # GUI 窗口模式，无黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
