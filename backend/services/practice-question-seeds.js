const db = require('../database/memory-db');

function getPracticeDifficulty(masteryRate) {
  return masteryRate < 40 ? 'easy' : (masteryRate < 60 ? 'medium' : 'hard');
}

function buildDifficultyVariant(item, difficulty) {
  const scoreMap = { easy: 10, medium: 14, hard: 18 };
  const scoreBoost = difficulty === 'medium' ? 2 : difficulty === 'hard' ? 4 : 0;
  return {
    ...item,
    score: Math.max(item.score || 0, scoreMap[difficulty]) + scoreBoost,
    difficulty
  };
}

function buildPracticeQuestionSeeds() {
  const knowledgePoints = db.find('knowledgePoints').filter(item => String(item.id || '').startsWith('kp-'));

  const specificBank = {
    '有理数': [
      { type: 'choice', content: '下列各数中，属于有理数的是？', options: ['√2', 'π', '-3', '0.1010010001…'], answer: '-3', score: 10 },
      { type: 'fill', content: '计算：-8 + 13 = ____', answer: '5', score: 12 },
      { type: 'shortAnswer', content: '请说明什么是有理数，并举一个正有理数和一个负有理数的例子。', answer: '有理数是可以写成两个整数比的数，例如 3/4 和 -2。', score: 18 }
    ],
    '有理数的加减法': [
      { type: 'choice', content: '计算 7 + (-11) 的结果是？', options: ['18', '-4', '4', '-18'], answer: '-4', score: 10 },
      { type: 'fill', content: '计算：-6 - 9 = ____', answer: '-15', score: 12 },
      { type: 'shortAnswer', content: '简述进行有理数加减混合运算时的步骤。', answer: '先统一成加法，再根据同号相加、异号相减的规则计算。', score: 18 }
    ],
    '有理数的乘除法': [
      { type: 'choice', content: '计算 (-3) × 5 的结果是？', options: ['15', '-15', '8', '-8'], answer: '-15', score: 10 },
      { type: 'fill', content: '计算：24 ÷ (-6) = ____', answer: '-4', score: 12 },
      { type: 'shortAnswer', content: '简述有理数乘除法的符号法则。', answer: '同号得正，异号得负，再计算绝对值。', score: 18 }
    ],
    '整式的加减': [
      { type: 'choice', content: '化简 3x + 2x 的结果是？', options: ['5x', '6x²', '5', 'x'], answer: '5x', score: 10 },
      { type: 'fill', content: '化简：4a - 7a = ____', answer: '-3a', score: 12 },
      { type: 'shortAnswer', content: '简述合并同类项时需要满足的条件。', answer: '所含字母相同且相同字母的指数也分别相同。', score: 18 }
    ],
    '一元一次方程': [
      { type: 'choice', content: '方程 2x + 5 = 13 的解是？', options: ['3', '4', '5', '6'], answer: '4', score: 10 },
      { type: 'fill', content: '解方程：x - 7 = 9，则 x = ____', answer: '16', score: 12 },
      { type: 'shortAnswer', content: '解方程 3x - 2 = 10，并写出主要步骤。', answer: '先移项得 3x = 12，再两边同时除以 3，得 x = 4。', score: 18 }
    ],
    '几何初步': [
      { type: 'choice', content: '线段有几个端点？', options: ['0个', '1个', '2个', '无数个'], answer: '2个', score: 10 },
      { type: 'fill', content: '一个周角等于 ____ 度。', answer: '360', score: 12 },
      { type: 'shortAnswer', content: '请简述射线、线段、直线三者的区别。', answer: '射线有一个端点，线段有两个端点，直线没有端点。', score: 18 }
    ],
    '相交线与平行线': [
      { type: 'choice', content: '两条平行线被第三条直线所截，内错角的关系是？', options: ['互补', '相等', '互余', '没有关系'], answer: '相等', score: 10 },
      { type: 'fill', content: '同一平面内，两条不重合且永不相交的直线叫做 ____。', answer: '平行线', score: 12 },
      { type: 'shortAnswer', content: '请写出平行线的两个常见性质。', answer: '同位角相等，内错角相等，同旁内角互补。', score: 18 }
    ],
    '实数': [
      { type: 'choice', content: '下列各数中，属于无理数的是？', options: ['1/2', '0.3', '√3', '-7'], answer: '√3', score: 10 },
      { type: 'fill', content: '9 的平方根是 ____。', answer: '±3', score: 12 },
      { type: 'shortAnswer', content: '请简述有理数与无理数的关系。', answer: '有理数和无理数统称为实数。', score: 18 }
    ],
    '平面直角坐标系': [
      { type: 'choice', content: '点 (3,-2) 位于第几象限？', options: ['第一象限', '第二象限', '第三象限', '第四象限'], answer: '第四象限', score: 10 },
      { type: 'fill', content: '原点的坐标是 ____。', answer: '(0,0)', score: 12 },
      { type: 'shortAnswer', content: '请说明在平面直角坐标系中如何确定一个点的位置。', answer: '先确定横坐标，再确定纵坐标，用有序数对表示。', score: 18 }
    ],
    '二元一次方程组': [
      { type: 'choice', content: '下列哪组数是方程组 x+y=5, x-y=1 的解？', options: ['x=3,y=2', 'x=2,y=3', 'x=4,y=1', 'x=1,y=4'], answer: 'x=3,y=2', score: 10 },
      { type: 'fill', content: '若 x+y=7, x=3，则 y= ____。', answer: '4', score: 12 },
      { type: 'shortAnswer', content: '简述代入法解二元一次方程组的基本思路。', answer: '先由一个方程表示一个未知数，再代入另一个方程求解。', score: 18 }
    ],
    '不等式与不等式组': [
      { type: 'choice', content: '解不等式 x+2>5，结果是？', options: ['x>3', 'x<3', 'x>7', 'x<7'], answer: 'x>3', score: 10 },
      { type: 'fill', content: '不等式 2x<8 的解集是 ____。', answer: 'x<4', score: 12 },
      { type: 'shortAnswer', content: '请说明解不等式时什么时候需要改变不等号方向。', answer: '当不等式两边同时乘或除以负数时，需要改变不等号方向。', score: 18 }
    ],
    '数据的收集与整理': [
      { type: 'choice', content: '调查全班同学最喜欢的运动项目，较适合采用哪种方式整理数据？', options: ['条形统计图', '函数图像', '坐标作图', '几何证明'], answer: '条形统计图', score: 10 },
      { type: 'fill', content: '把收集到的数据按类别分组并统计数量，这个过程叫做数据的 ____。', answer: '整理', score: 12 },
      { type: 'shortAnswer', content: '请简述数据收集与整理的一般步骤。', answer: '先确定调查对象与方式，再收集数据，最后分类整理并进行分析。', score: 18 }
    ]
  };

  const seeds = [];
  const difficulties = ['easy', 'medium', 'hard'];

  knowledgePoints.forEach((knowledgePoint) => {
    const specificItems = specificBank[knowledgePoint.name] || [
      { type: 'choice', content: `关于“${knowledgePoint.name}”的学习，下列做法最合理的是？`, options: [`先理解${knowledgePoint.name}的概念再练习`, '直接背答案', '忽略题干条件', '只看结论'], answer: `先理解${knowledgePoint.name}的概念再练习`, score: 10 },
      { type: 'fill', content: `完成“${knowledgePoint.name}”相关题目时，最关键的是掌握正确的 ____。`, answer: '方法', score: 12 },
      { type: 'shortAnswer', content: `请简述你解决“${knowledgePoint.name}”相关题目时的标准思路。`, answer: `先审题并提取与${knowledgePoint.name}相关的条件，再选择对应方法，按步骤作答并检查结果。`, score: 18 }
    ];

    difficulties.forEach((difficulty) => {
      specificItems.forEach((item, index) => {
        seeds.push({
          id: `seed-specific-${knowledgePoint.id}-${difficulty}-${index + 1}`,
          ...buildDifficultyVariant({
            type: item.type,
            content: item.content,
            options: item.options || [],
            answer: item.answer,
            score: item.score,
            knowledgePoints: [knowledgePoint.id],
            knowledgePointId: knowledgePoint.id,
            source: 'practice-seed',
            practiceSource: 'specific-bank'
          }, difficulty)
        });
      });

      [1, 2].forEach((seedIndex) => {
        seeds.push(
          {
            id: `seed-general-${knowledgePoint.id}-${difficulty}-choice-${seedIndex}`,
            ...buildDifficultyVariant({
              type: 'choice',
              content: `知识点【${knowledgePoint.name}】选择题 ${seedIndex}：下列哪一项最符合“${knowledgePoint.description || (knowledgePoint.name + '相关训练')}”的学习目标？`,
              options: [
                `准确理解并应用${knowledgePoint.name}的核心方法`,
                '忽略题干条件直接套公式',
                '只看结果不分析过程',
                '将无关知识点混入解题步骤'
              ],
              answer: `准确理解并应用${knowledgePoint.name}的核心方法`,
              score: 10,
              knowledgePoints: [knowledgePoint.id],
              knowledgePointId: knowledgePoint.id,
              source: 'practice-seed',
              practiceSource: 'general-bank'
            }, difficulty)
          },
          {
            id: `seed-general-${knowledgePoint.id}-${difficulty}-fill-${seedIndex}`,
            ...buildDifficultyVariant({
              type: 'fill',
              content: `知识点【${knowledgePoint.name}】填空题 ${seedIndex}：完成该知识点训练后，你应当能够独立完成“${knowledgePoint.name}”相关题目的________。`,
              answer: '关键步骤',
              score: 12,
              knowledgePoints: [knowledgePoint.id],
              knowledgePointId: knowledgePoint.id,
              source: 'practice-seed',
              practiceSource: 'general-bank'
            }, difficulty)
          },
          {
            id: `seed-general-${knowledgePoint.id}-${difficulty}-short-${seedIndex}`,
            ...buildDifficultyVariant({
              type: 'shortAnswer',
              content: `知识点【${knowledgePoint.name}】简答题 ${seedIndex}：请简述你解决“${knowledgePoint.name}”相关题目时的标准思路。`,
              answer: `先审题并提取与${knowledgePoint.name}相关的条件，再选择对应方法，按步骤作答并检查结果。`,
              score: 18,
              knowledgePoints: [knowledgePoint.id],
              knowledgePointId: knowledgePoint.id,
              source: 'practice-seed',
              practiceSource: 'general-bank'
            }, difficulty)
          }
        );
      });
    });
  });

  return seeds;
}

module.exports = {
  buildPracticeQuestionSeeds,
  getPracticeDifficulty
};
