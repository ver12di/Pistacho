// --- 步骤 1: 您的 configData JSON 字符串 (已嵌入) ---
const currentConfigDataString = `{"description":"V1.1","totalWeightMax":95,"ratingCriteria":[{"criteriaList":[{"name":"茄标美感","weight":15,"options":[{"scorePct":0.1,"description":"简陋"},{"description":"中规中矩","scorePct":0.5},{"scorePct":0.7,"description":"漂亮"},{"description":"完美","scorePct":1}]},{"weight":15,"options":[{"scorePct":0.1,"description":"简陋"},{"description":"中规中矩","scorePct":0.5},{"description":"漂亮","scorePct":0.7},{"scorePct":1,"description":"完美"}],"name":"茄衣呈现"},{"name":"卷工目测","weight":15,"options":[{"scorePct":0.1,"description":"不合格"},{"scorePct":0.5,"description":"正常"},{"scorePct":0.7,"description":"漂亮"},{"description":"完美","scorePct":1}]}],"totalWeight":30,"category":"1. 外观与卷工","detail":"雪茄的物理制造质量。"},{"category":"2. 燃烧与气道","criteriaList":[{"weight":15,"options":[{"scorePct":0.7,"description":"松"},{"scorePct":1,"description":"完美"},{"scorePct":0.66,"description":"偏紧"},{"scorePct":0,"description":"堵塞"}],"name":"吸阻"},{"weight":0,"options":[{"scorePct":0,"description":"白"},{"scorePct":0,"description":"灰"},{"description":"黑","scorePct":0}],"name":"烟灰颜色"},{"options":[{"scorePct":1,"description":"完美到可以尝试持灰"},{"scorePct":0.7,"description":"需要主动弹灰"},{"scorePct":0.3,"description":"自动脱落"}],"name":"烟灰形态","weight":10},{"name":"燃烧线","weight":15,"options":[{"description":"均匀","scorePct":1},{"scorePct":0.5,"description":"略有斜烧但是可以自己回正"},{"scorePct":0.3,"description":"有斜烧需要补几次火"},{"scorePct":0,"description":"需要不断修正"}]},{"name":"燃烧持续","options":[{"scorePct":1,"description":"一根到底"},{"scorePct":0.7,"description":"偶尔补火"},{"scorePct":0.3,"description":"不断补火"},{"description":"补到放弃","scorePct":0}],"weight":15}],"detail":"决定品鉴过程是否顺畅愉快的核心要素。","totalWeight":65},{"detail":"香气，变化，尼古丁等味觉感受","category":"味觉和感受","criteriaList":[{"weight":5,"options":[{"scorePct":1,"description":"眼前一亮"},{"scorePct":0.7,"description":"有期待"},{"description":"中规中矩","scorePct":0.5},{"description":"估计不怎么样","scorePct":0.1}],"name":"前三口感受"},{"weight":20,"name":"宜人的第二香气强度（不算咖啡、皮革、辛辣。主要为花香、香料、奶香、甜香等）","options":[{"scorePct":0,"description":"没有"},{"scorePct":0.3,"description":"一点点香"},{"description":"香","scorePct":0.5},{"description":"很香","scorePct":0.7},{"scorePct":1,"description":"极香"}]},{"weight":10,"name":"第二香气在其他雪茄中获得难度或高级度","options":[{"description":"容易在其他雪茄获得","scorePct":0.3},{"description":"不容易但偶有获得","scorePct":0.7},{"description":"独特风味很少获得","scorePct":1},{"description":"没有第二香气","scorePct":0}]},{"name":"第二香气持续度","weight":15,"options":[{"description":"三段中仅一段有","scorePct":0.33},{"description":"三段中有二段有","scorePct":0.66},{"description":"三段都有","scorePct":1},{"scorePct":0,"description":"三段都没有"}]},{"options":[{"scorePct":0,"description":"没有"},{"scorePct":1,"description":"有"}],"name":"多重（第三）香气","weight":15},{"options":[{"scorePct":0.33,"description":"三段仅一段有"},{"scorePct":0.66,"description":"三段有二段有"},{"scorePct":1,"description":"三段都有"},{"scorePct":0,"description":"没有"}],"weight":15,"name":"多重（第三）香气持续度"},{"options":[{"scorePct":1,"description":"变化明显"},{"description":"似乎有变化","scorePct":0.5},{"description":"始终如一","scorePct":0.1}],"weight":15,"name":"三段变化"},{"name":"烟雾量","options":[{"description":"少","scorePct":0.7},{"description":"多","scorePct":1},{"description":"烟囱","scorePct":0.69}],"weight":15},{"options":[{"scorePct":1,"description":"普通"},{"scorePct":0.7,"description":"噩梦"},{"description":"地狱","scorePct":0.5}],"name":"尼古丁浓度","weight":10},{"name":"过鼻顺畅度","options":[{"scorePct":1,"description":"柔顺"},{"scorePct":0.5,"description":"略有刺激"},{"description":"辛辣不能过鼻","scorePct":0}],"weight":15}]},{"criteriaList":[{"name":"抽完烟屁股意愿","options":[{"description":"尽早掐灭","scorePct":0},{"scorePct":0.5,"description":"抽到本人日常处"},{"scorePct":0.7,"description":"抽到烧手"},{"scorePct":1,"description":"插牙签抽完"}],"weight":10},{"weight":10,"name":"复购意愿","options":[{"description":"买不起","scorePct":0.7},{"scorePct":0,"description":"不愿复购"},{"description":"愿意复购","scorePct":1},{"scorePct":0.5,"description":"不值得"}]},{"name":"记忆度","weight":15,"options":[{"scorePct":0,"description":"芸芸众生"},{"description":"略有印象","scorePct":0.4},{"scorePct":0.7,"description":"念念不忘"},{"scorePct":1,"description":"梦里寻他千百度"}]},{"name":"抽吸时间","options":[{"description":"30min以内","scorePct":0},{"description":"30-60min","scorePct":0},{"scorePct":0,"description":"60-90min"},{"scorePct":0,"description":"90-120min"},{"description":"120min以上","scorePct":0}],"weight":0},{"name":"推荐指数","options":[{"description":"不在list","scorePct":0},{"scorePct":0,"description":"偶尔提提"},{"description":"可以有","scorePct":0},{"scorePct":0,"description":"强推"},{"scorePct":0,"description":"必须有"}],"weight":0}],"detail":"","category":"意愿与感受"}],"appTitle":"Pistacho Cigar Rating System"}`;

// --- 步骤 2: 中文到 Key 的映射 (根据你的 zh.json 和 configData 生成) ---
// !!! 请再次检查这个映射的准确性，特别是标记为 "// 假设 Key" 的条目 !!!
const chineseToKeyMap = {
  // 基本信息 (如果需要 Key 的话)
  "V1.1": "config.description.v1_1", // 假设 Key - 请在 zh.json 中确认或添加
  "Pistacho Cigar Rating System": "nav.title", // 使用了导航标题作为应用标题 Key

  // 类别 (Category) & 细节 (Detail)
  "1. 外观与卷工": "criteria.appearanceAndConstruction.title", // 假设 Key
  "雪茄的物理制造质量。": "criteria.appearanceAndConstruction.detail", // 假设 Key
  "2. 燃烧与气道": "criteria.burnAndDraw.title", // 假设 Key
  "决定品鉴过程是否顺畅愉快的核心要素。": "criteria.burnAndDraw.detail", // 假设 Key
  "味觉和感受": "criteria.flavorAndFeel.title", // 假设 Key
  "香气，变化，尼古丁等味觉感受": "criteria.flavorAndFeel.detail", // 假设 Key
  "意愿与感受": "criteria.willingnessAndImpression.title", // 假设 Key
  // "" (空字符串 detail) 不需要映射

  // 标准 (Criterion Name)
  "茄标美感": "criteria.appearanceAndConstruction.bandAesthetics", // 假设 Key
  "茄衣呈现": "criteria.appearanceAndConstruction.wrapperAppearance", // 假设 Key
  "卷工目测": "criteria.appearanceAndConstruction.rollVisual", // 假设 Key
  "吸阻": "criteria.burnAndDraw.drawResistance", // 假设 Key
  "烟灰颜色": "criteria.burnAndDraw.ashColor", // 假设 Key
  "烟灰形态": "criteria.burnAndDraw.ashStructure", // 假设 Key
  "燃烧线": "criteria.burnAndDraw.burnLine", // 假设 Key
  "燃烧持续": "criteria.burnAndDraw.burnConsistency", // 假设 Key
  "前三口感受": "criteria.flavorAndFeel.firstImpressions", // 假设 Key
  "宜人的第二香气强度（不算咖啡、皮革、辛辣。主要为花香、香料、奶香、甜香等）": "criteria.flavorAndFeel.secondaryAromaIntensity", // 假设 Key
  "第二香气在其他雪茄中获得难度或高级度": "criteria.flavorAndFeel.secondaryAromaUniqueness", // 假设 Key
  "第二香气持续度": "criteria.flavorAndFeel.secondaryAromaDuration", // 假设 Key
  "多重（第三）香气": "criteria.flavorAndFeel.tertiaryAromaPresence", // 假设 Key
  "多重（第三）香气持续度": "criteria.flavorAndFeel.tertiaryAromaDuration", // 假设 Key
  "三段变化": "criteria.flavorAndFeel.transitions", // 假设 Key
  "烟雾量": "criteria.flavorAndFeel.smokeVolume", // 假设 Key
  "尼古丁浓度": "criteria.flavorAndFeel.nicotineStrength", // 假设 Key
  "过鼻顺畅度": "criteria.flavorAndFeel.retrohaleSmoothness", // 假设 Key
  "抽完烟屁股意愿": "criteria.willingnessAndImpression.finishDesire", // 假设 Key
  "复购意愿": "criteria.willingnessAndImpression.rebuyIntention", // 假设 Key
  "记忆度": "criteria.willingnessAndImpression.memorability", // 假设 Key
  "抽吸时间": "criteria.willingnessAndImpression.smokingTime", // 假设 Key
  "推荐指数": "criteria.willingnessAndImpression.recommendation", // 假设 Key

  // 选项 (Option Description)
  "简陋": "options.appearance.shoddy", // 假设 Key
  "中规中矩": "options.common.average", // 假设 Key (zh.json 中没有这个，您可能需要添加: "average": "中规中矩")
  "漂亮": "options.appearance.beautiful", // 假设 Key
  "完美": "options.common.perfect", // 假设 Key
  "不合格": "options.construction.fail", // 假设 Key
  "正常": "options.common.normal", // 假设 Key
  "松": "options.draw.loose", // 假设 Key
  "偏紧": "options.draw.tight", // 假设 Key
  "堵塞": "options.draw.plugged", // 假设 Key
  "白": "options.ashColor.white", // 假设 Key
  "灰": "options.ashColor.gray", // 假设 Key
  "黑": "options.ashColor.black", // 假设 Key
  "完美到可以尝试持灰": "options.ashStructure.perfectHold", // 假设 Key
  "需要主动弹灰": "options.ashStructure.needsTapping", // 假设 Key
  "自动脱落": "options.ashStructure.fallsOff", // 假设 Key
  "均匀": "options.burnLine.even", // 假设 Key
  "略有斜烧但是可以自己回正": "options.burnLine.correctsItself", // 假设 Key
  "有斜烧需要补几次火": "options.burnLine.needsCorrection", // 假设 Key
  "需要不断修正": "options.burnLine.constantCorrection", // 假设 Key
  "一根到底": "options.burnConsistency.perfect", // 假设 Key
  "偶尔补火": "options.burnConsistency.occasionalRelight", // 假设 Key
  "不断补火": "options.burnConsistency.frequentRelight", // 假设 Key
  "补到放弃": "options.burnConsistency.gaveUp", // 假设 Key
  "眼前一亮": "options.impression.excellent", // 假设 Key
  "有期待": "options.impression.promising", // 假设 Key
  "估计不怎么样": "options.impression.poor", // 假设 Key
  "没有": "options.aroma.none", // 假设 Key
  "一点点香": "options.aroma.light", // 假设 Key
  "香": "options.aroma.medium", // 假设 Key
  "很香": "options.aroma.strong", // 假设 Key
  "极香": "options.aroma.veryStrong", // 假设 Key
  "容易在其他雪茄获得": "options.uniqueness.common", // 假设 Key
  "不容易但偶有获得": "options.uniqueness.uncommon", // 假设 Key
  "独特风味很少获得": "options.uniqueness.rare", // 假设 Key
  "没有第二香气": "options.uniqueness.none", // 假设 Key (可能与 options.aroma.none 重复，根据需要调整)
  "三段中仅一段有": "options.duration.oneThird", // 假设 Key
  "三段中有二段有": "options.duration.twoThirds", // 假设 Key
  "三段都有": "options.duration.full", // 假设 Key
  "三段都没有": "options.duration.none", // 假设 Key (可能与 options.aroma.none 重复)
  "有": "options.presence.yes", // 假设 Key
  "三段仅一段有": "options.tertiaryDuration.oneThird", // 假设 Key (与 options.duration.oneThird 重复，可能需要调整)
  "三段有二段有": "options.tertiaryDuration.twoThirds", // 假设 Key (与 options.duration.twoThirds 重复)
  "变化明显": "options.transition.obvious", // 假设 Key
  "似乎有变化": "options.transition.subtle", // 假设 Key
  "始终如一": "options.transition.consistent", // 假设 Key
  "少": "options.smoke.low", // 假设 Key
  "多": "options.smoke.medium", // 假设 Key
  "烟囱": "options.smoke.high", // 假设 Key
  "普通": "options.nicotine.normal", // 假设 Key (也可能用 options.common.normal)
  "噩梦": "options.nicotine.strong", // 假设 Key
  "地狱": "options.nicotine.veryStrong", // 假设 Key
  "柔顺": "options.retrohale.smooth", // 假设 Key
  "略有刺激": "options.retrohale.slightIrritation", // 假设 Key
  "辛辣不能过鼻": "options.retrohale.harsh", // 假设 Key
  "尽早掐灭": "options.finish.early", // 假设 Key
  "抽到本人日常处": "options.finish.normal", // 假设 Key
  "抽到烧手": "options.finish.nubbed", // 假设 Key
  "插牙签抽完": "options.finish.toothpick", // 假设 Key
  "买不起": "options.rebuy.tooExpensive", // 假设 Key
  "不愿复购": "options.rebuy.no", // 假设 Key
  "愿意复购": "options.rebuy.yes", // 假设 Key
  "不值得": "options.rebuy.notWorthIt", // 假设 Key
  "芸芸众生": "options.memory.forgettable", // 假设 Key
  "略有印象": "options.memory.slightImpression", // 假设 Key
  "念念不忘": "options.memory.memorable", // 假设 Key
  "梦里寻他千百度": "options.memory.unforgettable", // 假设 Key
  "30min以内": "options.time.under30", // 假设 Key
  "30-60min": "options.time.30to60", // 假设 Key
  "60-90min": "options.time.60to90", // 假设 Key
  "90-120min": "options.time.90to120", // 假设 Key
  "120min以上": "options.time.over120", // 假设 Key
  "不在list": "options.recommend.notListed", // 假设 Key
  "偶尔提提": "options.recommend.mention", // 假设 Key
  "可以有": "options.recommend.consider", // 假设 Key
  "强推": "options.recommend.strong", // 假设 Key
  "必须有": "options.recommend.mustHave" // 假设 Key
};

// --- 步骤 3: 转换函数 (无需修改) ---
function transformConfigData(data, map) {
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(item => transformConfigData(item, map));
  }
  const newData = {};
  for (const key in data) {
    let newKey = key;
    let value = data[key];
    if (key === 'category') newKey = 'categoryKey';
    if (key === 'detail') newKey = 'detailKey';
    if (key === 'name') newKey = 'nameKey';
    if (key === 'description') newKey = 'descriptionKey';
    if (typeof value === 'string' && map[value] !== undefined) { // Check if key exists in map
      newData[newKey] = map[value];
    } else {
      newData[newKey] = transformConfigData(value, map);
    }
  }
  // Handle top-level appTitle and description if they are keys in the map
  // Note: Your data uses 'appTitle' key, not its value 'Pistacho Cigar Rating System'
  newData.appTitle = map[data.appTitle] || data.appTitle; // If 'Pistacho...' is mapped, use it, else keep original
  newData.description = map[data.description] || data.description; // If 'V1.1' is mapped, use it, else keep original

  return newData;
}

// --- 步骤 4: 执行转换并打印结果 (无需修改) ---
try {
  const currentConfig = JSON.parse(currentConfigDataString);
  const newConfig = transformConfigData(currentConfig, chineseToKeyMap);
  const newConfigDataString = JSON.stringify(newConfig, null, 2); // Format output

  console.log("--- 转换后的 configData JSON ---");
  console.log(newConfigDataString);
  console.log("\n--- 请仔细检查上面的 JSON，确保所有中文都已替换为 Key ---");
  console.log("--- 然后将上面的 JSON 字符串用于 Cloudflare D1 的 UPDATE 语句 ---");

} catch (e) {
  console.error("处理 JSON 时出错:", e);
  console.log("请检查输入的 JSON 字符串格式是否正确以及映射 (`chineseToKeyMap`) 是否完整且正确定义。");
}