import { describe, expect, it } from "vitest";

import { hasNarratorSwitchCue } from "@/domain/invariants/validate-continuation";

/**
 * 叙述者切换连接词的词法判定。
 *
 * 多字连接词任意位置生效；单字 `但/可/却` 必须排除常见复合词与
 * “可能/可以/可怜/可惜/却步/冷却”等普通词，否则角色转述会被误判成
 * 叙述者的直接断言（或反过来）。全部为自建短句。
 */
describe("canon narrator switch cue", () => {
  it("recognizes multi-character turn phrases anywhere in the segment", () => {
    for (const text of [
      "但是他走了",
      "可是他走了",
      "然而他走了",
      "不过他走了",
      "其实他走了",
      "事实上他走了",
      "实际上他走了",
      "他以为没人知道但是灯塔熄灭从未发生过",
    ]) {
      expect(hasNarratorSwitchCue(text), text).toBe(true);
    }
  });

  it("treats 但 as a turn except in 但愿/但凡/不但", () => {
    expect(hasNarratorSwitchCue("他以为没人知道但灯塔熄灭从未发生过")).toBe(
      true,
    );
    expect(hasNarratorSwitchCue("但愿明天风平浪静")).toBe(false);
    expect(hasNarratorSwitchCue("但凡他早点来")).toBe(false);
    expect(hasNarratorSwitchCue("不但没有停下")).toBe(false);
  });

  it("treats 可 only at a clause start and not as a compound", () => {
    expect(hasNarratorSwitchCue("可灯塔熄灭从未发生过")).toBe(true);
    expect(hasNarratorSwitchCue("，可灯塔熄灭从未发生过")).toBe(true);
    expect(hasNarratorSwitchCue("他可能记错了")).toBe(false);
    expect(hasNarratorSwitchCue("他可以走了")).toBe(false);
    expect(hasNarratorSwitchCue("可怜的孩子")).toBe(false);
    expect(hasNarratorSwitchCue("可惜来不及了")).toBe(false);
    expect(hasNarratorSwitchCue("可爱的小岛")).toBe(false);
    expect(hasNarratorSwitchCue("可见他错了")).toBe(false);
    expect(hasNarratorSwitchCue("可靠的人")).toBe(false);
    expect(hasNarratorSwitchCue("可怕的夜晚")).toBe(false);
    expect(hasNarratorSwitchCue("可笑的想法")).toBe(false);
    expect(hasNarratorSwitchCue("可疑的脚印")).toBe(false);
    // 位于动词之后、又不是分句起点：不是转折。
    expect(hasNarratorSwitchCue("他说可她走了")).toBe(false);
  });

  it("treats 却 as a turn at a clause start or after a short subject only", () => {
    expect(hasNarratorSwitchCue("他却走了")).toBe(true);
    expect(hasNarratorSwitchCue("老人却摇了摇头")).toBe(true);
    expect(hasNarratorSwitchCue("却是这样")).toBe(true);
    expect(hasNarratorSwitchCue("，却没有人回答")).toBe(true);
    expect(hasNarratorSwitchCue("冷却了")).toBe(false);
    expect(hasNarratorSwitchCue("推却了邀请")).toBe(false);
    expect(hasNarratorSwitchCue("退却了半步")).toBe(false);
    expect(hasNarratorSwitchCue("却步不前")).toBe(false);
  });

  it("only scans the requested segment", () => {
    const sentence = "他以为没人知道，但灯塔熄灭从未发生过";
    const butIndex = sentence.indexOf("但");
    expect(hasNarratorSwitchCue(sentence, 0, butIndex)).toBe(false);
    expect(hasNarratorSwitchCue(sentence, butIndex, sentence.length)).toBe(
      true,
    );
  });
});
