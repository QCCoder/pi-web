# dev Loop · LEARN（终态归档规范）

> 这是 orchestrator 在**终态**内联执行的归档规范（不另开子代理——learn 既不是 maker 也不是 checker，不需要隔离）。到终态时（final-verify 解析后、或早期泊车；**Round 0 idle 除外**）按本文件执行两件事：写瘦审计 + 可选写知识库笔记。

## ① 瘦审计日志：`loops/dev-loop/LEARN.jsonl`
append 一条 JSON（一行，**不自己重判**，字段从 PLAN/VERDICT 抄）：
```json
{"runId":"<runId>","workItemKey":"<KEY|null>","module":"<module|null>","repo":"<repo|null>","predictedConf":"high|med|low","riskTier":"sensitive|normal","outcome":"merged|rejected|blocked","tests":"green|red|none","ts":"<ISO>"}
```
- 一 run 一条。**不写长 humanDecision**（那是旧 schema；经验价值走②进知识库，不堆在 JSONL 里）。
- 这是机器可读的**审计轨迹**（将来若复活校准数学的数据源）。不是给人读的叙事。

## ② 知识库学习笔记（仅当通过泛化测试）
只有**可泛化的流程/判定级规则**才进知识库。代码指针级事实（类名/方法名/具体 KEY）**不进**——它们会随代码腐烂，对 kb_search 是噪音。

### 泛化测试（硬，机械执行）
把这条教训里的具体 key/类名/方法名删掉，剩下那句话**还是不是一条规则**、对未来 selector/architect/developer 有没有指导意义？
- ✅ 通过：`查询类需求必须 trace 完整请求路径含后端专用拦截器，不能只看通用组装器` / `断言"文件/模块不存在"前先确认本地 master 最新` / `subagent 产出须 orchestrator 读源码核实`
- ❌ 不通过：`<某 ServiceImpl> 硬编码 OR 连接` / `<某 KEY> 误拆后并回`（删掉具体名就什么都不是）
- 没通过的经验：**只留①LEARN.jsonl 审计，不写②知识库笔记**。代码特定事实的归宿是工作项自己的 PLAN/DESIGN/IMPLEMENTATION.md（在 git 里）。

### 通过则写 OKF 笔记
路径：`<知识库根>/learnings/<safe-module>-<runId>.md`（`learningNotePath`；知识库根以磁盘实际为准，见工作区 manifest 里 `kind: knowledge` 的仓库目录）。
frontmatter：`type: learning`、`module`、`author: loop`、`autoManaged: true`、`derivedFrom: run:<runId>`、`tags: [module, ...]`。正文 = H1 标题（规则一句话）+ 正文（规则 + 本次触发场景一句话，不抄代码）。

### 反污染（硬）
- **永远新建文件，永不编辑已有笔记**（`learningNotePath` 含 runId 保证唯一）。这 trivially 满足"人改过的笔记即权威，loop 不覆写"。
- 一 run 最多一篇笔记（多条规则合并成一篇，不为每条规则开一个文件）。
- *为什么这样分*：模块级特定陷阱（费用状态机、敏感清单）归 `standards/dev-loop-modules.md`（人手维护 + loop append）；可泛化规则归 `learnings/`（loop 写）。两件产物不重叠。
