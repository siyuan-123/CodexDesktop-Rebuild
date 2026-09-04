const test = require("node:test");
const assert = require("node:assert/strict");
const acorn = require("acorn");
const vm = require("node:vm");

const {
  DIRECT_ACTION_ID,
  MARKER,
  SIDEBAR_MARKER,
  hasNativeDirectAction,
  patchSidebarSource,
  patchSource,
} = require("./patch-thread-file-manager-action");

function createGroupedMenuBundle(options = {}) {
  const openHelper = options.includeOpenHelper === false
    ? ""
    : [
        "function openItem(input){",
        "let{scope,appPath,openInSidePanel,cwd,hostId,path,",
        "persistPreferredTargetPath,target,openMode}=input;",
        "if(target!=null||openMode===`workspace`||persistPreferredTargetPath!=null){",
        "scope.open({path,cwd,hostId,target,appPath});return}",
        "if(openInSidePanel)scope.open({path,cwd,hostId,target:`fileManager`})",
        "}",
      ].join("");
  const menuBuilder = [
    "function buildOpenItems({scope:s,cwd:c,hostId:h}){",
    "let request={cwd:c,hostId:h,path:void 0};",
    "let data=s.query.getData(targets,request);",
    "s.query.fetch(targets,request).catch(()=>{});",
    "let report=()=>`localConversation.openTarget.error`;",
    "return makeOpenMenu({",
    "targets:data?.targets.map(item=>item),",
    "message:`localConversationPage.openPrimaryTarget`,",
    "onOpenInTarget:(target,appPath)=>{",
    "s.get(openMutation).mutate({path:c,cwd:c,hostId:h,target,appPath,",
    "openMode:`workspace`,persistPreferredTargetPath:c},{onError:report})",
    "}",
    "})",
    "}",
    ...(options.includeCopySignature === false
      ? []
      : ["const copyMessage=`threadHeader.copyActions`;"]),
  ].join("");
  return openHelper + menuBuilder;
}

function evaluatePatchedMenu(source, platform) {
  const context = {
    navigator: { userAgentData: { platform } },
    targets: {},
    openMutation: {},
    opened: null,
    makeOpenMenu: () => [{ id: "open-workspace-in", icon: "open-icon" }],
  };
  context.scope = {
    get: () => ({ mutate() {} }),
    open: (params) => {
      context.opened = params;
    },
    query: {
      fetch: () => Promise.resolve(),
      getData: () => ({
        targets: [{ target: "fileManager", resolvedIcon: "folder-icon" }],
      }),
    },
  };
  vm.runInNewContext(
    `${source};result=buildOpenItems({scope,cwd:\`C:\\\\repo\`,hostId:\`local\`})`,
    context,
  );
  return context;
}

function createSidebarMenuBundle() {
  return [
    "function buildThreadMenu({scope:s,target:t}){",
    "let{conversationId:id,hostId:h,cwd:c}=t,items=[];",
    "let primary=[{id:`rename-thread`},{id:`archive-thread`}];",
    "return c!=null&&!getState(s.get,`remote_control_connections`)",
    "?.some(item=>item.hostId===h)&&s.get(gitBacked,id)",
    "&&items.push(...buildOpenItems({scope:s,cwd:normalize(c),hostId:h})),",
    "items.push({id:`open-in-new-window`}),",
    "[...primary,...items]",
    "}",
  ].join("");
}

function evaluatePatchedSidebar(source, options = {}) {
  const context = {
    gitBacked: {},
    getState: () => options.remoteConnections ?? [],
    normalize: (cwd) => cwd,
    buildOpenItems: () => [{ id: DIRECT_ACTION_ID }],
    scope: { get: () => false },
  };
  vm.runInNewContext(
    `${source};result=buildThreadMenu({scope,target:{` +
      `conversationId:\`thread-1\`,hostId:\`local\`,cwd:${
        options.cwd === null ? "null" : "`C:\\\\repo`"
      }}})`,
    context,
  );
  return context.result;
}

test("新版对话菜单增加顶层文件管理器入口并保留打开方式子菜单", () => {
  const result = patchSource(createGroupedMenuBundle());

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
  assert.ok(result.source.includes(`id:\`${DIRECT_ACTION_ID}\``));
  assert.match(
    result.source,
    /onSelect:\(\)=>openItem\(\{scope:s,path:c,cwd:c,hostId:h,target:`fileManager`,openMode:`workspace`\}\)/,
  );
  assert.match(
    result.source,
    /sidebarElectron\.openWorkspaceRootInExplorer/,
  );
  assert.match(result.source, /navigator\?\.userAgentData\?\.platform/);
  assert.match(result.source, /\.toLowerCase\(\)/);
  assert.match(result.source, /\.startsWith\(`mac`\)/);
  assert.match(result.source, /\.\.\.__codexOpenWorkspaceItems/);
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("候选识别不依赖上游已移除的复制动作签名", () => {
  const source = createGroupedMenuBundle({ includeCopySignature: false });

  assert.equal(source.includes("threadHeader.copyActions"), false);
  assert.equal(patchSource(source).status, "patched");
});

test("侧边栏普通目录会话不再受 Git 仓库门控", () => {
  const original = createSidebarMenuBundle();
  const result = patchSidebarSource(original);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(SIDEBAR_MARKER));
  assert.doesNotMatch(result.source, /s\.get\(gitBacked,id\)/);
  assert.equal(
    evaluatePatchedSidebar(result.source).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    true,
  );
  assert.doesNotThrow(() =>
    acorn.parse(result.source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }),
  );
});

test("侧边栏入口仍要求工作目录且排除远程控制连接", () => {
  const { source } = patchSidebarSource(createSidebarMenuBundle());

  assert.equal(
    evaluatePatchedSidebar(source, { cwd: null }).some(
      (item) => item.id === DIRECT_ACTION_ID,
    ),
    false,
  );
  assert.equal(
    evaluatePatchedSidebar(source, {
      remoteConnections: [{ hostId: "local" }],
    }).some((item) => item.id === DIRECT_ACTION_ID),
    false,
  );
});

test("侧边栏补丁重复执行保持幂等", () => {
  const first = patchSidebarSource(createSidebarMenuBundle());
  const second = patchSidebarSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("侧边栏结构变化时明确失败而不是静默跳过", () => {
  const result = patchSidebarSource(
    "function changedThreadMenu(){return [{id:`rename-thread`}]}",
  );

  assert.equal(result.status, "unexpected-sidebar-menu-gate-count");
  assert.equal(result.count, 0);
});

test("补丁重复执行保持幂等", () => {
  const first = patchSource(createGroupedMenuBundle());
  const second = patchSource(first.source);

  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
});

test("顶层入口按系统显示文案并复用 fileManager 打开链路", () => {
  const { source } = patchSource(createGroupedMenuBundle());
  const cases = [
    ["Windows", "sidebarElectron.openWorkspaceRootInExplorer"],
    ["macOS", "sidebarElectron.openWorkspaceRootInFinder"],
    ["Linux", "sidebarElectron.openWorkspaceRootInFileManager"],
  ];

  for (const [platform, messageId] of cases) {
    const context = evaluatePatchedMenu(source, platform);
    assert.equal(context.result[0].id, DIRECT_ACTION_ID);
    assert.equal(context.result[0].message.id, messageId);
    assert.equal(context.result[0].icon, "folder-icon");
    assert.equal(context.result[1].id, "open-workspace-in");

    context.result[0].onSelect();
    assert.equal(context.opened.target, "fileManager");
    assert.equal(context.opened.cwd, "C:\\repo");
    assert.equal("persistPreferredTargetPath" in context.opened, false);
  }
});

test("旧版已有顶层 open-thread-folder 时安全跳过", () => {
  const source =
    "const items=[{id:`open-thread-folder`,message:folder,onSelect:openFolder}];";

  assert.equal(hasNativeDirectAction(source), true);
  assert.equal(patchSource(source).status, "native");
});

test("新旧菜单实现共存时优先修补新版动作聚合器", () => {
  const source =
    "const legacy=[{id:`open-thread-folder`,onSelect:openFolder}];" +
    createGroupedMenuBundle();
  const result = patchSource(source);

  assert.equal(result.status, "patched");
  assert.ok(result.source.includes(MARKER));
});

test("打开链路缺失时拒绝生成不完整补丁", () => {
  const result = patchSource(
    createGroupedMenuBundle({ includeOpenHelper: false }),
  );

  assert.equal(result.status, "unexpected-open-helper-count");
  assert.equal(result.count, 0);
});
