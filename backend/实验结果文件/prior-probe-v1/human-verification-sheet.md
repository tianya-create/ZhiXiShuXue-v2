# 先修边人工核验工作表（方案 §2.4）

核验日期：____ ｜ 核验人：____（按教材目录/课标独立判对错，勿参照 reason 列）

判定标准：source → target 语义为「掌握 target 之前应先掌握 source」。对 = 该教学顺序成立；错 = 不成立/反向/无关系。

## A. 候选边（入选 prior-edges.csv）40 条 —— 报 precision

| # | source | target | conf | votes | 对/错 |
|---|---|---|---|---|---|
| 1 | Addition and Subtraction Integers | Multiplication and Division Integers | 2,2 | 2 | |
| 2 | Addition Whole Numbers | Perimeter of a Polygon | 3,3,3 | 3 | |
| 3 | Angles - Obtuse, Acute, and Right | Angles on Parallel Lines Cut by a Transversal | 2,2 | 2 | |
| 4 | Angles - Obtuse, Acute, and Right | Interior Angles Triangle | 2,2 | 2 | |
| 5 | Area Circle | Volume Cylinder | 3,3,3 | 3 | |
| 6 | Area Parallelogram | Area Trapezoid | 3,3,3 | 3 | |
| 7 | Area Rectangle | Area Triangle | 3,3,3 | 3 | |
| 8 | Area Triangle | Area Irregular Figure | 2,2 | 2 | |
| 9 | Circumference | Surface Area Cylinder | 2,2 | 2 | |
| 10 | D.4.8-understanding-concept-of-probabilities | Probability of a Single Event | 3,3,3 | 3 | |
| 11 | Equation Solving More Than Two Steps | Quadratic Formula to Solve Quadratic Equation | 2,2 | 2 | |
| 12 | Equation Solving Two or Fewer Steps | Equation Solving More Than Two Steps | 3,3,3 | 3 | |
| 13 | Equivalent Fractions | Conversion of Fraction Decimals Percents | 3,3,3 | 3 | |
| 14 | Exponents | Order of Operations All | 3,3,3 | 3 | |
| 15 | Exponents | Square Root | 2,2,3 | 3 | |
| 16 | Finding Slope from Ordered Pairs | Write Linear Equation from Ordered Pairs | 3,3,3 | 3 | |
| 17 | Interior Angles Triangle | Interior Angles Figures with More than 3 Sides | 3,3,3 | 3 | |
| 18 | Least Common Multiple | Addition and Subtraction Fractions | 2,2 | 2 | |
| 19 | Multiplication and Division Positive Decimals | Unit Rate | 2,2 | 2 | |
| 20 | Number Line | Ordering Integers | 3,3,3 | 3 | |
| 21 | Order of Operations +,-,/,* () positive reals | Order of Operations All | 3,3,3 | 3 | |
| 22 | Order of Operations All | Equation Solving Two or Fewer Steps | 3,3,3 | 3 | |
| 23 | Ordering Integers | Stem and Leaf Plot | 2,2 | 2 | |
| 24 | Parts of a Polyomial, Terms, Coefficient, Monomial, Exponent, Variable | Simplifying Expressions positive exponents | 2,2 | 2 | |
| 25 | Percent Of | Percent Discount | 3,3,3 | 3 | |
| 26 | Percents | Percent Of | 3,3,3 | 3 | |
| 27 | Probability of a Single Event | Probability of Two Distinct Events | 3,3,3 | 3 | |
| 28 | Range | Box and Whisker | 3,3,3 | 3 | |
| 29 | Rounding | Estimation | 3,3,3 | 3 | |
| 30 | Scale Factor | Effect of Changing Dimensions of a Shape Prportionally | 3,3,3 | 3 | |
| 31 | Solving Systems of Linear Equations | Solving Systems of Linear Equations by Graphing | 2,2 | 2 | |
| 32 | Square Root | Quadratic Formula to Solve Quadratic Equation | 3,3,3 | 3 | |
| 33 | Table | Histogram as Table or Graph | 2,2,2 | 3 | |
| 34 | Unit Rate | Rate | 2,2 | 2 | |
| 35 | Write Linear Equation from Graph | Solving Systems of Linear Equations by Graphing | 3,3,3 | 3 | |

## B. 被投票规则否决的边（仅 1/3 次出现）40 条 —— 检验规则是否误杀

| # | source | target | 出现轮次 | 对/错 |
|---|---|---|---|---|
| 1 | Addition and Subtraction Positive Decimals | Multiplication and Division Positive Decimals | 2 | |
| 2 | Area Rectangle | Surface Area Rectangular Prism | 2 | |
| 3 | Equivalent Fractions | Proportion | 2 | |
| 4 | Multiplication and Division Positive Decimals | Unit Conversion Within a System | 2 | |
| 5 | Stem and Leaf Plot | Box and Whisker | 3 | |

> 通过线：A 组 precision ≥ 0.75，且第二核验人（同学/数学老师，标其中 50 条）κ ≥ 0.60。
> 不达标 → 改一次 prompt 重跑三次抽取；仍不达标 → 判定「先修关系不适合 LLM 抽取」，直接进终止分支。
