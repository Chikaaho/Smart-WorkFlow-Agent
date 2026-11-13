# @sw-agent/cli

安装：

```bash
npm install -g @sw-agent/cli
```

进入项目目录后启动：

```bash
cd /path/to/project
sw-agent
```

当前目录是默认项目目录。进入 Pi 后运行 `/init` 初始化项目 Workspace，运行 `/workflow` 开始任务。OCX 已配置但代理未运行时会自动启动；OCX 尚未安装或没有可用账号时，运行 `/ocx-setup` 查看配置步骤。

输入 `/exit` 或 `exit` 退出；`/quit`、`quit` 和空输入框下的 `Ctrl+D` 也可退出。

项目说明、配置和完整使用流程见 [Smart-WorkFlow-Agent](https://github.com/Chikaaho/Smart-WorkFlow-Agent)。
