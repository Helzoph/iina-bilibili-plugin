# IINA Bilibili 插件的常用命令，`just` 查看列表

set shell := ["bash", "-euo", "pipefail", "-c"]

iina_plugin := "/Applications/IINA.app/Contents/MacOS/iina-plugin"
# 可用环境变量 IINA_PLUGINS_DIR 指向别处（测试用）
plugins_dir := env("IINA_PLUGINS_DIR", home_directory() / "Library/Application Support/com.colliderli.iina/plugins")
dev_link := plugins_dir / file_name(justfile_directory()) + ".iinaplugin-dev"
version := `sed -n 's/^ *"version": *"\(.*\)",*$/\1/p' Info.json`

# 列出所有命令
default:
    @just --list --unsorted

# 把 src/ 打包成 dist/index.js
build:
    node build.js

# 运行全部测试（离线）
test: build
    node --test 'tests/*.test.js'

# 测试并输出覆盖率
coverage: build
    node --test --experimental-test-coverage --test-coverage-include='src/**' 'tests/*.test.js'

# 以开发模式安装：在 IINA 插件目录建立指向本目录的链接，之后改代码只需 just build 并重启 IINA
install: test
    #!/usr/bin/env bash
    set -euo pipefail
    link="{{dev_link}}"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "{{justfile_directory()}}" ]; then
      echo "已经安装（开发模式）：$link"
    elif [ -e "$link" ] || [ -L "$link" ]; then
      echo "插件目录里已有同名文件，未做修改，请先检查：$link" >&2
      exit 1
    else
      mkdir -p "{{plugins_dir}}"
      ln -s "{{justfile_directory()}}" "$link"
      echo "已安装（开发模式）：$link"
    fi
    echo "请用 ⌘Q 退出 IINA 后重新打开；不要用“重新加载所有插件”。"

# 移除开发模式的链接（只删链接，不动本目录）
uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    link="{{dev_link}}"
    if [ -L "$link" ]; then
      rm "$link"
      echo "已移除：$link"
      echo "请用 ⌘Q 退出 IINA 后重新打开。"
    else
      echo "没有找到开发模式链接：$link"
    fi

# 生成可分发的 build/bilibili-<版本>.iinaplgz，只包含运行所需文件
pack: test
    #!/usr/bin/env bash
    set -euo pipefail
    stage="$(mktemp -d)"
    trap 'rm -r "$stage"' EXIT
    mkdir "$stage/bilibili"
    cp -R Info.json pref.html dist sidebar "$stage/bilibili/"
    # iina-plugin pack 只接受相对路径，传绝对路径会报 “Cannot read plugin package content”
    (cd "$stage" && "{{iina_plugin}}" pack bilibili >/dev/null)
    mkdir -p build
    mv -f "$stage/bilibili-{{version}}.iinaplgz" build/
    echo "已生成 build/bilibili-{{version}}.iinaplgz"

# 打包后交给 IINA 安装（适合不想保留开发链接的情况）
install-pack: pack
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -L "{{dev_link}}" ]; then
      echo "已有开发模式安装，两份同时存在会重复加载，请先运行 just uninstall" >&2
      exit 1
    fi
    open -a IINA "build/bilibili-{{version}}.iinaplgz"
    echo "请在 IINA 弹出的对话框里确认安装，然后 ⌘Q 重启 IINA。"
