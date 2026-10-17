const edgeTypeExamples = [
  {
    type: "causes",
    example: "她把唯一的钥匙摔碎，门因此再也打不开。",
  },
  {
    type: "enables",
    example: "他提前拿到地图，才有可能在雨停前找到出口。",
  },
  {
    type: "foreshadows",
    example: "墙上的裂缝预示后来的坍塌，但洪水并不是它造成的。",
  },
] as const;

/** Edge 类型的一句话示例；与 StoryMap edge type 枚举保持一一对应。 */
export function EdgeTypeHelp() {
  return (
    <div className="edge-type-help">
      <small>三种关系各一句示例：</small>
      <ul>
        {edgeTypeExamples.map((item) => (
          <li key={item.type}>
            <strong>{item.type}</strong>
            <span>{item.example}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
