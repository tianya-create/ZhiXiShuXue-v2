from pathlib import Path

student_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\routes\student.js')
text = student_path.read_text(encoding='utf-8')
text = text.replace('questionCount: item.isLeaf ? ensurePracticeQuestionsForKnowledgePoint(studentId, item.id).length : 0,', 'questionCount: item.isLeaf ? getPracticeQuestionsForKnowledgePoint(studentId, item.id).length : 0,')
student_path.write_text(text, encoding='utf-8')
