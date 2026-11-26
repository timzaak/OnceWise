# PRD 索引

| Feature | 域 | 标题 | 优先级 | 发布时间 | 文档 |
|---|---|---|---|---|---|
| self-service-browser-automation | core | 自助浏览器局部自动化（外部 AI 验证闭环版 · 受约束步骤树） | P0 | 2026-09-24（2026-09-26 修订：受约束步骤树运行期，DEC-019；2026-09-30 修订：交接通道切换本机通道，见 support-native-messaging；2026-10-02 修订：放开同站顺序跨页，见 cross-page-flow；2026-10-03 修订：流程输入值交叉引用，见 form-support；2026-11-02 修订：步骤树新增上报请求步骤，见 support-http；2026-11-25 修订：触发模型新增定时触发，见 support-scheduler） | [core/self-service-browser-automation.md](core/self-service-browser-automation.md) |
| data-sync | core | 脚本同步与空间协作（无账号 · 本地优先） | P0 | 2026-09-25（2026-09-26 修订：流程同步边界，DEC-data-sync-011；2026-10-03 修订：后端存储迁移 PostgreSQL，DEC-data-sync-012；2026-10-09 修订：无账号边界限定空间模型层面，部署层默认 Herald 门禁，见 herald-support；2026-10-15 修订：组织绑定空间（空间权限与角色重开），见 space-permissions；2026-11-25 修订：登记官方托管部署形态（官方/自建双模式，DEC-data-sync-013）） | [core/data-sync.md](core/data-sync.md) |
| support-native-messaging | core | 本机通道流程交接（Chrome Native Messaging） | P0 | 2026-09-30 | [core/support-native-messaging.md](core/support-native-messaging.md) |
| cross-page-flow | core | 跨页流程（同站顺序跨页续跑） | P0 | 2026-10-02 | [core/cross-page-flow.md](core/cross-page-flow.md) |
| form-support | core | 运行前输入与流程复用（流程输入表单） | P1 | 2026-10-03（补发布；能力已随 v1.1.0 于 2026-10-02 交付） | [core/form-support.md](core/form-support.md) |
| support-http | core | 流程 HTTP 上报数据采集（受约束步骤树 · 上报请求步骤） | P1 | 2026-11-02（2026-11-25 修订：上报无预演路径、运行取消中止进行中的上报请求） | [core/support-http.md](core/support-http.md) |
| support-scheduler | core | 流程定时执行（受约束步骤树 · 定时触发） | P1 | 2026-11-25（补发布；能力已随 v1.3.0 于 2026-10-17 交付） | [core/support-scheduler.md](core/support-scheduler.md) |
| herald-support | auth | Herald 鉴权支持（服务级访问门禁 · 默认启用） | P0 | 2026-10-09（2026-10-15 修订：空间级排除口径由组织绑定空间重建，见 space-permissions；2026-11-25 修订：门禁层表述限定为密钥空间口径） | [auth/herald-support.md](auth/herald-support.md) |
| space-permissions | auth | 空间权限与角色（组织绑定空间 · 一次性邀请码 · 成员管理） | P0 | 2026-10-15（2026-11-25 修订：管理员移除成员时作废该空间在途未用邀请码，落实"旧邀请码不能重入"） | [auth/space-permissions.md](auth/space-permissions.md) |
