import { type Claims, generateToken, md5Hex } from "../crypto";
import { type ForwardRow, type PanelDB, sanitizeUser } from "../db/queries";
import { SETUP_DONE_KEY } from "../db/schema";
import {
  fail,
  minVal,
  notBlank,
  notNull,
  numInt,
  ok,
  paramInt,
  parseNum,
  parseStr,
  type R,
  strBlank,
} from "../utils/validation";

export interface UserRouteDeps {
  db: PanelDB;
  jwtSecret: string;
  tzOffsetMin: number;
  deleteForwardInternal(f: ForwardRow): Promise<void>;
}

export function handleSetupStatus(db: PanelDB): R {
  return ok({ needSetup: db.needSetup() });
}

export function handleSetupInit(
  deps: UserRouteDeps,
  body: Record<string, unknown>,
): R {
  const username = parseStr(body.username);
  const password = parseStr(body.password);
  notBlank(username, "管理员用户名不能为空");
  if (!password.valid || password.v === "") {
    return fail("管理员密码不能为空");
  }
  const name = username.v.trim();
  if (!deps.db.needSetup()) {
    return fail("系统已经初始化过了，请直接登录");
  }
  if (deps.db.countOf("SELECT COUNT(*) FROM user WHERE user = ? AND role_id != 0", name) > 0) {
    return fail("该用户名已被普通用户使用");
  }

  const now = Date.now();
  const existing = deps.db.sql
    .exec<{ id: number }>("SELECT id FROM user WHERE role_id = 0 ORDER BY id LIMIT 1")
    .toArray()[0];

  let id: number;
  if (!existing) {
    deps.db.sql.exec(
      `INSERT INTO user (user, pwd, role_id, exp_time, flow, in_flow, out_flow, flow_reset_time, num, created_time, updated_time, status)
       VALUES (?, ?, 0, 2727251700000, 99999, 0, 0, 1, 99999, ?, ?, 1)`,
      name,
      md5Hex(password.v),
      now,
      now,
    );
    id = deps.db.lastInsertId();
  } else {
    id = existing.id;
    deps.db.sql.exec(
      "UPDATE user SET user = ?, pwd = ?, status = 1, updated_time = ? WHERE id = ?",
      name,
      md5Hex(password.v),
      now,
      id,
    );
  }

  deps.db.setSetting(SETUP_DONE_KEY, "true");
  const u = deps.db.getUser(id)!;
  return ok({
    token: generateToken(u, deps.jwtSecret),
    name: u.user,
    role_id: u.roleId,
    requirePasswordChange: false,
  });
}

export function handleUserLogin(
  deps: UserRouteDeps,
  body: Record<string, unknown>,
): R {
  const username = parseStr(body.username);
  const password = parseStr(body.password);
  notBlank(username, "用户名不能为空");
  notBlank(password, "密码不能为空");
  if (deps.db.needSetup()) {
    return fail("系统尚未初始化，请刷新页面后先设置管理员账号");
  }
  // 私人站点默认关闭验证码，避免旧库遗留 captcha_enabled=true 导致无法登录
  const u = deps.db.getUserByName(username.v);
  if (!u || u.pwd !== md5Hex(password.v)) {
    return fail("账号或密码错误");
  }
  if (u.status === 0) {
    return fail("账号被停用");
  }
  return ok({
    token: generateToken(u, deps.jwtSecret),
    name: u.user,
    role_id: u.roleId,
    requirePasswordChange: false,
  });
}

function validateUserForm(body: Record<string, unknown>, update: boolean) {
  const id = parseNum(body.id);
  const user = parseStr(body.user);
  const pwd = parseStr(body.pwd);
  const flow = parseNum(body.flow);
  const num = parseNum(body.num);
  const expTime = parseNum(body.expTime);
  const flowResetTime = parseNum(body.flowResetTime);
  const status = parseNum(body.status);

  if (update) notNull(id, "用户ID不能为空");
  notBlank(user, "用户名不能为空");
  if (!update) notBlank(pwd, "密码不能为空");
  notNull(flow, "流量不能为空");
  minVal(flow, 0, "流量不能小于0");
  notNull(num, "转发数量不能为空");
  minVal(num, 0, "转发数量不能小于0");
  notNull(expTime, "过期时间不能为空");
  notNull(flowResetTime, "流量重置时间不能为空");
  return { id, user, pwd, flow, num, expTime, flowResetTime, status };
}

export function handleUserCreate(db: PanelDB, body: Record<string, unknown>): R {
  const d = validateUserForm(body, false);
  if (db.countOf("SELECT COUNT(*) FROM user WHERE user = ?", d.user.v) > 0) {
    return fail("用户名已存在");
  }
  const now = Date.now();
  db.sql.exec(
    `INSERT INTO user (user, pwd, role_id, exp_time, flow, in_flow, out_flow, flow_reset_time, num, created_time, updated_time, status)
     VALUES (?, ?, 1, ?, ?, 0, 0, ?, ?, ?, ?, 1)`,
    d.user.v,
    md5Hex(d.pwd.v),
    numInt(d.expTime),
    numInt(d.flow),
    numInt(d.flowResetTime),
    numInt(d.num),
    now,
    now,
  );
  return ok();
}

export function handleUserList(db: PanelDB): R {
  const list = db.listUsers("WHERE role_id != 0").map(sanitizeUser);
  return ok(list);
}

export function handleUserUpdate(db: PanelDB, body: Record<string, unknown>): R {
  const d = validateUserForm(body, true);
  const uid = numInt(d.id);
  const u = db.getUser(uid);
  if (!u) return fail("用户不存在");
  if (u.roleId === 0) return fail("请不要作死");
  if (db.countOf("SELECT COUNT(*) FROM user WHERE user = ? AND id != ?", d.user.v, uid) > 0) {
    return fail("用户名已存在");
  }

  const sets = [
    "user = ?",
    "flow = ?",
    "num = ?",
    "exp_time = ?",
    "flow_reset_time = ?",
    "updated_time = ?",
  ];
  const args: unknown[] = [
    d.user.v,
    numInt(d.flow),
    numInt(d.num),
    numInt(d.expTime),
    numInt(d.flowResetTime),
    Date.now(),
  ];
  if (!strBlank(d.pwd)) {
    sets.push("pwd = ?");
    args.push(md5Hex(d.pwd.v));
  }
  if (d.status.valid) {
    sets.push("status = ?");
    args.push(numInt(d.status));
  }
  args.push(uid);
  db.sql.exec(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`, ...args);

  if (numInt(d.expTime) !== u.expTime) {
    db.sql.exec("UPDATE user_tunnel SET exp_time = ? WHERE user_id = ?", numInt(d.expTime), u.id);
  }
  return ok();
}

export async function handleUserDelete(
  deps: UserRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  const u = deps.db.getUser(id);
  if (!u) return fail("用户不存在");
  if (u.roleId === 0) return fail("请不要作死");
  for (const f of deps.db.listForwards("WHERE user_id = ?", id)) {
    await deps.deleteForwardInternal(f);
  }
  deps.db.sql.exec("DELETE FROM forward WHERE user_id = ?", id);
  deps.db.sql.exec("DELETE FROM user_tunnel WHERE user_id = ?", id);
  deps.db.sql.exec("DELETE FROM statistics_flow WHERE user_id = ?", id);
  deps.db.sql.exec("DELETE FROM user_flow_daily WHERE user_id = ?", id);
  deps.db.sql.exec("DELETE FROM user WHERE id = ?", id);
  return ok();
}

export function handleUserPackage(deps: UserRouteDeps, claims: Claims): R {
  const u = deps.db.getUser(claims.userId);
  if (!u) return fail("用户不存在");
  const userInfo = {
    id: u.id,
    name: null,
    user: u.user,
    status: u.status,
    flow: u.flow,
    inFlow: u.inFlow,
    outFlow: u.outFlow,
    num: u.num,
    expTime: u.expTime,
    flowResetTime: u.flowResetTime,
    createdTime: u.createdTime,
    updatedTime: u.updatedTime,
  };

  const tunnelRows = deps.db.sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT ut.id, ut.user_id, ut.tunnel_id, t.name AS tunnel_name, t.flow AS tunnel_flow,
              ut.flow, ut.in_flow, ut.out_flow, ut.num, ut.flow_reset_time, ut.exp_time,
              ut.speed_id, sl.name AS speed_name, sl.speed
       FROM user_tunnel ut
       LEFT JOIN tunnel t ON ut.tunnel_id = t.id
       LEFT JOIN speed_limit sl ON ut.speed_id = sl.id
       WHERE ut.user_id = ? ORDER BY ut.id`,
      u.id,
    )
    .toArray();
  const tunnels = tunnelRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    tunnelId: r.tunnel_id,
    tunnelName: r.tunnel_name ?? null,
    tunnelFlow: r.tunnel_flow ?? null,
    flow: r.flow,
    inFlow: r.in_flow,
    outFlow: r.out_flow,
    num: r.num,
    flowResetTime: r.flow_reset_time ?? null,
    expTime: r.exp_time ?? null,
    speedId: r.speed_id ?? null,
    speedLimitName: r.speed_name ?? null,
    speed: r.speed ?? null,
  }));

  const fwRows = deps.db.sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT f.id, f.name, f.tunnel_id, t.name AS tunnel_name, t.in_ip, f.remote_addr,
              f.in_flow, f.out_flow, f.status, f.created_time
       FROM forward f LEFT JOIN tunnel t ON f.tunnel_id = t.id
       WHERE f.user_id = ? ORDER BY f.created_time DESC`,
      u.id,
    )
    .toArray();

  const forwards = fwRows.map((r) => {
    const id = Number(r.id);
    const tunnelId = Number(r.tunnel_id);
    const item: Record<string, unknown> = {
      id,
      name: r.name,
      tunnelId,
      tunnelName: r.tunnel_name ?? null,
      inIp: r.in_ip ?? null,
      inPort: null,
      remoteAddr: r.remote_addr,
      inFlow: r.in_flow,
      outFlow: r.out_flow,
      status: r.status,
      createdTime: r.created_time,
    };
    const addr = deps.db.forwardEntryAddress(id, tunnelId);
    if (addr.found) {
      item.inPort = addr.inPort;
      if (addr.inIp) item.inIp = addr.inIp;
    }
    return item;
  });

  return ok({
    userInfo,
    tunnelPermissions: tunnels,
    forwards,
    statisticsFlows: deps.db.last24HoursFlow(u.id, deps.tzOffsetMin),
  });
}

export function handleUserUpdatePassword(
  db: PanelDB,
  claims: Claims,
  body: Record<string, unknown>,
): R {
  const newUsername = parseStr(body.newUsername);
  const currentPassword = parseStr(body.currentPassword);
  const newPassword = parseStr(body.newPassword);
  const confirmPassword = parseStr(body.confirmPassword);
  notBlank(newUsername, "新用户名不能为空");
  notBlank(currentPassword, "当前密码不能为空");
  notBlank(newPassword, "新密码不能为空");
  notBlank(confirmPassword, "确认密码不能为空");

  const u = db.getUser(claims.userId);
  if (!u) return fail("用户不存在");
  if (newPassword.v !== confirmPassword.v) return fail("新密码和确认密码不匹配");
  if (u.pwd !== md5Hex(currentPassword.v)) return fail("当前密码错误");
  if (
    u.user !== newUsername.v &&
    db.countOf("SELECT COUNT(*) FROM user WHERE user = ? AND id != ?", newUsername.v, u.id) > 0
  ) {
    return fail("用户名已存在");
  }
  db.sql.exec(
    "UPDATE user SET user = ?, pwd = ?, updated_time = ? WHERE id = ?",
    newUsername.v,
    md5Hex(newPassword.v),
    Date.now(),
    u.id,
  );
  return ok();
}

export function handleUserReset(db: PanelDB, body: Record<string, unknown>): R {
  const id = parseNum(body.id);
  const type = parseNum(body.type);
  notNull(id, "重置账号id不能为空");
  notNull(type, "重置类型不能为空");
  const targetId = numInt(id);
  if (numInt(type) === 1) {
    if (!db.getUser(targetId)) return fail("用户不存在");
    db.sql.exec("UPDATE user SET in_flow = 0, out_flow = 0 WHERE id = ?", targetId);
  } else {
    if (!db.getUserTunnelById(targetId)) return fail("隧道不存在");
    db.sql.exec("UPDATE user_tunnel SET in_flow = 0, out_flow = 0 WHERE id = ?", targetId);
  }
  return ok();
}
