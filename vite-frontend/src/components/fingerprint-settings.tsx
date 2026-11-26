import { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Input } from "@heroui/input";
import { Divider } from "@heroui/divider";
import toast from "react-hot-toast";

import { getFingerprint, saveFingerprint } from "@/api";

const FP_RE = /^[A-Za-z0-9]{8}$/;

/** 面板指纹：节点端重装时用来判断是同一个面板（覆盖更新）还是另一个面板（共存安装） */
export default function FingerprintSettings() {
  const [current, setCurrent] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "regen">("");

  const apply = (fp: string) => {
    setCurrent(fp);
    setValue(fp);
  };

  useEffect(() => {
    getFingerprint()
      .then(res => {
        if (res.code === 0) apply(res.data.fingerprint || "");
      })
      .catch(() => {});
  }, []);

  const submit = async (regenerate: boolean) => {
    if (!regenerate && !FP_RE.test(value)) {
      toast.error("指纹必须是 8 位英文字母或数字");
      return;
    }
    setBusy(regenerate ? "regen" : "save");
    try {
      const res = await saveFingerprint({ fingerprint: value, regenerate });
      if (res.code === 0) {
        apply(res.data.fingerprint);
        toast.success(regenerate ? "已重新生成指纹" : "指纹已保存");
      } else {
        toast.error(res.msg || "保存失败");
      }
    } catch {
      toast.error("保存失败");
    } finally {
      setBusy("");
    }
  };

  const invalid = value !== "" && !FP_RE.test(value);
  const changed = value !== current;

  return (
    <Card className="fz-card">
      <CardHeader className="px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 w-full">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold text-foreground">面板指纹</h2>
            <p className="text-xs text-default-500 mt-0.5">
              识别节点归属面板：指纹相同覆盖更新，不同则共存安装（随数据库备份同步）
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
            <Button size="sm" variant="flat" className="whitespace-nowrap" isLoading={busy === "regen"} onPress={() => submit(true)}>
              重新生成
            </Button>
            <Button
              size="sm"
              color="primary"
              className="whitespace-nowrap"
              isDisabled={!changed || !FP_RE.test(value)}
              isLoading={busy === "save"}
              onPress={() => submit(false)}
            >
              保存指纹
            </Button>
          </div>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="px-5 py-5 space-y-4">
        <Input
          label="指纹"
          value={value}
          onValueChange={v => setValue(v.trim())}
          maxLength={8}
          variant="bordered"
          className="font-mono sm:max-w-xs"
          isInvalid={invalid}
          errorMessage={invalid ? "必须是 8 位英文字母或数字" : undefined}
        />
        <div className="text-xs text-default-500 space-y-1">
          <p>· 一般不需要修改。只有用同一份备份恢复出两套面板时，才需要把其中一套改掉，否则它们的节点会互相覆盖。</p>
          <p>· 修改后已安装的节点不受影响，重装时会通过节点密钥认出来并更新为新指纹；修改后请重新复制节点安装命令。</p>
        </div>
      </CardBody>
    </Card>
  );
}
