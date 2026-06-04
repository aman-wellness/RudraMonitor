// Lightweight name-to-gender heuristic. Handles common Indian + Western
// first names plus a phonetic fallback for unknown entries. Returns 'male',
// 'female', or 'unknown'.
//
// This is intentionally NOT a giant database — we ship a small curated list
// of common names that covers most enterprise rosters, then fall back to
// suffix patterns. Customers can extend the list when they hit a miss.

const MALE_NAMES = new Set<string>([
  // Indian
  'aman', 'aditya', 'akshay', 'akshit', 'amit', 'anmol', 'anuj', 'arjun', 'arun',
  'ashish', 'ashvani', 'avinash', 'ayush', 'bhavesh', 'boban', 'chetan', 'deepak',
  'dev', 'dhruv', 'divyendhu', 'gagan', 'gaurav', 'harsh', 'himanshu', 'imran',
  'ishaan', 'jasmeet', 'jay', 'jomin', 'karan', 'krishna', 'kunal', 'manoj',
  'manpreet', 'mayur', 'mitesh', 'mohit', 'nagireddy', 'nikhil', 'nitin', 'paawan',
  'pawan', 'piyush', 'prakash', 'prateek', 'pulkit', 'rahul', 'rajesh', 'raju',
  'rakesh', 'ravi', 'rohan', 'rohit', 'ronit', 'robin', 'sachin', 'sandeep',
  'sanjay', 'shafeeque', 'shashank', 'sheraz', 'shubham', 'siddharth', 'sonu',
  'sorabh', 'subhash', 'sumit', 'suraj', 'suresh', 'tarun', 'tushar', 'uday',
  'umang', 'utkarsh', 'vaibhav', 'varun', 'vibhor', 'vikram', 'vinay', 'vipin',
  'virender', 'vishal', 'vivek', 'yash', 'abhishek', 'mukesh',
  // Western
  'aaron', 'adam', 'alex', 'andrew', 'anthony', 'ben', 'benjamin', 'brian',
  'carl', 'charles', 'chris', 'christopher', 'daniel', 'david', 'dennis',
  'derek', 'eric', 'frank', 'gary', 'george', 'greg', 'henry', 'ian', 'jack',
  'james', 'jason', 'jeff', 'john', 'jonathan', 'joseph', 'josh', 'kevin',
  'kyle', 'larry', 'liam', 'mark', 'matt', 'matthew', 'michael', 'mike',
  'nathan', 'nicholas', 'noah', 'oliver', 'oscar', 'patrick', 'paul', 'peter',
  'philip', 'richard', 'rick', 'robert', 'ryan', 'samuel', 'scott', 'sean',
  'simon', 'stephen', 'steve', 'thomas', 'tim', 'tom', 'will', 'william',
]);

const FEMALE_NAMES = new Set<string>([
  // Indian
  'aarti', 'aditi', 'akansha', 'akshara', 'alisha', 'amrita', 'anjali', 'ankita',
  'anushka', 'aparna', 'arpita', 'asha', 'avni', 'bhavana', 'chitra', 'deepa',
  'deepika', 'devika', 'diksha', 'divya', 'esha', 'gauri', 'geeta', 'harshita',
  'haritha', 'isha', 'ishika', 'jyoti', 'kajal', 'kanika', 'kavita', 'khushi',
  'komal', 'krati', 'kriti', 'lakshmi', 'lehri', 'madhuri', 'mahima', 'manisha',
  'maya', 'meera', 'meghana', 'mohini', 'mukta', 'nandini', 'neeta', 'neha',
  'nidhi', 'nikita', 'nisha', 'nita', 'pallavi', 'pari', 'parul', 'pooja',
  'poonam', 'prachi', 'pragya', 'pratibha', 'preeti', 'priya', 'priyanka',
  'radhika', 'rani', 'rashmi', 'rekha', 'richa', 'riddhi', 'rina', 'ritu',
  'sahana', 'sakshi', 'sangeeta', 'sanjana', 'sapna', 'sarika', 'savita',
  'seema', 'shalini', 'shanti', 'sharmila', 'shilpa', 'shreya', 'shruti',
  'simran', 'sneha', 'sonali', 'sonia', 'srishti', 'sudha', 'suhani', 'suman',
  'sumana', 'surangama', 'sushma', 'swati', 'tara', 'tina', 'trisha', 'upasana',
  'urvashi', 'usha', 'vandana', 'vidya', 'vijaya', 'vimla', 'yamini', 'yashika',
  // Western
  'alice', 'amanda', 'amy', 'andrea', 'anna', 'ashley', 'barbara', 'beth',
  'brenda', 'carol', 'caroline', 'catherine', 'charlotte', 'chloe', 'claire',
  'crystal', 'daisy', 'deborah', 'diana', 'donna', 'elizabeth', 'ella',
  'emily', 'emma', 'eva', 'fiona', 'grace', 'hannah', 'helen', 'isabella',
  'jane', 'janet', 'jennifer', 'jessica', 'julia', 'karen', 'kate', 'katie',
  'kelly', 'kim', 'laura', 'lauren', 'linda', 'lisa', 'lucy', 'maria',
  'mary', 'megan', 'melissa', 'michelle', 'nancy', 'natalie', 'nicole',
  'olivia', 'pamela', 'patricia', 'rachel', 'rebecca', 'rose', 'ruth',
  'sandra', 'sarah', 'sharon', 'sophia', 'stephanie', 'susan', 'tina',
  'tracy', 'victoria',
]);

// Phonetic fallback — kicks in when the first name isn't in either set.
// Suffix patterns are loose but skew right for typical Indian + Western names.
function suffixGuess(first: string): 'male' | 'female' | 'unknown' {
  if (first.length < 3) return 'unknown';
  const f = first.toLowerCase();

  // Strongly female suffixes.
  if (/(?:a|i|ee|ie|ya|ika|ita|isha|ali|ini|ani|priya|wati|mati|rini|jali)$/.test(f)) {
    // But weed out clearly-male exceptions ending in 'a' (Krishna, Aman).
    const maleA = new Set(['krishna', 'aman', 'arnav', 'siddhartha', 'subroto']);
    if (maleA.has(f)) return 'male';
    return 'female';
  }
  // Strongly male suffixes.
  if (/(?:an|in|en|ar|al|av|am|ay|it|esh|raj|deep|jeet|veer|preet|kumar|singh|reddy)$/.test(f)) {
    return 'male';
  }
  return 'unknown';
}

export function detectGender(fullName: string): 'male' | 'female' | 'unknown' {
  if (!fullName) return 'unknown';
  // First token only — most names have given name first.
  const first = fullName.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return 'unknown';
  if (MALE_NAMES.has(first))   return 'male';
  if (FEMALE_NAMES.has(first)) return 'female';
  return suffixGuess(first);
}
