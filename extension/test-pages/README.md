# SSBA 受控测试页

本地静态验证场所（楔子试验与 PRD §5.2 验收目标 1–3 的执行地）：零外部 CDN 依赖、零网络请求。

## 启动

在本目录执行一行命令（任选其一）：

```bash
python -m http.server 8123
# 或
npx -y serve -l 8123 .
```

然后访问 <http://localhost:8123/>（入口页，含各页说明）。

## 站点访问

受控页经 `http://localhost:8123` 访问即可：扩展的 `host_permissions`（`http://*/*`、`https://*/*`）
在安装时已统一获得，流程自带站点域名，无需任何单独授权步骤，也**无需**"允许访问文件网址"开关。

不建议 `file://` 直开：`file://` 不在扩展 host 权限范围内；如确需使用，需在扩展详情页单独开启
文件访问权限，路径为 `file:///<本目录绝对路径>/form-page.html`。

## 页面清单

| 文件 | 角色 | 关键验证点 |
| --- | --- | --- |
| `index.html` | 入口/说明 | 非命中负样本 |
| `form-page.html` | 命中页 A | 页面指纹（`urlIncludes = "/form-page.html"`）、仿 antd 下拉（`select-widget.js`）、原生下拉、提交按钮「保存」、成功横幅（提交类动作 `preState` 目标） |
| `other-page.html` | 隔离样本 | 同站同字段 id、不同路径：命中特征为 form-page 的流程在此零动作零失败记录 |
| `app-spa.html` | SPA 模拟 | hash 路由 `#/step1`/`#/step2`；「重新加载视图」同 document 重挂——L2 去重；浏览器刷新——L3 会话 token 跳过（含提交类的流程）/ 重新执行（非提交流程） |
| `select-widget.js` | 仿 antd DOM 契约下拉 | 验证 `selectOption` 原语机制（`.ant-select*` / `.rc-virtual-list-holder` 类名契约）；真实 antd React 集成行为仍属未验证项 |
| `wizard-step1.html` | 跨页向导第 1 步（填写） | 业务号 `#orderNo` 可读、必填输入、提交按钮整页跳转第 2 步；`?biz=` 覆盖业务号 |
| `wizard-step2.html` | 跨页向导第 2 步（确认） | 业务号跨页复核面（`#orderNo`）、确认跳转第 3 步；`?open=new-tab` 变体经 `target=_blank` 在新标签页打开第 3 步；`?biz=` 换单据号（business-changed 取消路径） |
| `wizard-step3.html` | 跨页向导第 3 步（结果） | 终态标记 `.done-marker`（等待/断言目标）、动作记录；`?scenario=slow` 延迟就绪信号约 3 秒（慢加载认领、越过 navigate 截止时间） |

对照样例流程：`.ai/skill-examples/oncewise-flow/warehouse-phone.example.json`
（发货仓库 → 联系电话联动，site 即 `http://localhost:8123`）。
