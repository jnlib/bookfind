const GEMINI_KEY = 'AIzaSyD2ydSdzN4Hdu1e4d3a2Pfv1iBe-w6EyjE';
const LIB_KEY    = '07f4b234a27b4e8d0bbaef41e070810c1f626991298cd1c5798356b2ca8ff62b';
const LIB_BASE   = 'https://data4library.kr/api';
const LIB_CODE   = '111021';
const JN_BASE    = 'https://jnlib.sen.go.kr';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    // ── /recommend ── 새 설계: 키워드 추출 → 정보나루 검색 → 점수 정렬 ──
    if (url.pathname === '/recommend' && request.method === 'POST') {
      try {
        const { query } = await request.json();

        // ① Gemini 1회: 검색 키워드 + 사서 멘트
        const prompt = `사용자의 고민/상황에 맞는 도서관 검색 키워드를 만들어줘.

JSON만 반환 (마크다운 없이):
{
  "keywords": ["키워드1","키워드2","키워드3","키워드4","키워드5"],
  "reply": "사서가 건네는 따뜻한 말 2-3문장. 사용자 고민에 공감하고, 책을 찾아보겠다는 내용.",
  "criteria": "어떤 종류의 책이 좋을지 한 줄 설명 (예: 위로와 공감을 주는 에세이)"
}

규칙:
- keywords는 5개, 다양한 각도로 (감정, 주제, 장르, 저자, 관련어)
- 너무 일반적인 단어(책, 도서관, 추천) 쓰지 마
- 한국어 도서 검색에 효과적인 단어로

사용자: ${query}`;

        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
          { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.3}}) }
        );
        if (!gemRes.ok) throw new Error('Gemini 오류 ' + gemRes.status);
        const gemData = await gemRes.json();
        const raw = gemData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());

        const keywords = parsed.keywords || [];
        const reply = parsed.reply || '관련 책을 찾아볼게요.';
        const criteria = parsed.criteria || '';

        // ② 정보나루 API: 키워드별 검색 (종로도서관 소장 도서)
        const allBooks = [];
        const seenIsbns = new Set();

        const searchPromises = keywords.map(function(kw) {
          const qs = new URLSearchParams({
            authKey: LIB_KEY, format: 'json',
            keyword: kw, pageSize: '10'
          });
          return fetch(`${LIB_BASE}/srchBooks?${qs}`)
            .then(r => r.json())
            .then(d => {
              let docs = d.response?.docs ?? [];
              if (!Array.isArray(docs)) docs = [docs];
              return docs.map(i => i.doc ?? i).filter(b => b.bookname && (b.isbn13 || b.isbn));
            })
            .catch(() => []);
        });

        const results = await Promise.all(searchPromises);

        // 중복 제거 + 수집
        const candidates = [];
        for (const books of results) {
          for (const b of books) {
            const isbn = b.isbn13 || b.isbn || '';
            if (!isbn || seenIsbns.has(isbn)) continue;
            seenIsbns.add(isbn);
            candidates.push(b);
          }
        }

        // 정보나루 bookExist API로 종로도서관 소장 확인 (병렬, 안정적)
        const existPromises = candidates.map(function(b) {
          const isbn = b.isbn13 || b.isbn;
          const qs = new URLSearchParams({ authKey: LIB_KEY, format: 'json', isbn13: isbn, libCode: LIB_CODE });
          return fetch(`${LIB_BASE}/bookExist?${qs}`)
            .then(r => r.json())
            .then(d => {
              const hasBook = d.response?.result?.hasBook === 'Y';
              const loanAvailable = d.response?.result?.loanAvailable === 'Y';
              return { book: b, exists: hasBook, available: loanAvailable };
            })
            .catch(() => ({ book: b, exists: false, available: false }));
        });

        const checked = await Promise.all(existPromises);
        for (const item of checked) {
          if (item.exists) {
            item.book._available = item.available;
            allBooks.push(item.book);
          }
        }

        if (allBooks.length === 0) {
          return json({ reply, books: [], message: '도서관에서 관련 책을 찾지 못했어요.' });
        }

        // ③ 점수 계산 (Gemini 호출 없이 Worker에서)
        const scored = allBooks.map(function(b) {
          let score = 0;
          const title = (b.bookname || '').toLowerCase();
          const author = (b.authors || '').toLowerCase();
          const desc = (b.description || '').toLowerCase();

          // 키워드 매칭 점수
          keywords.forEach(function(kw) {
            const kwl = kw.toLowerCase();
            if (title.includes(kwl)) score += 15;
            if (author.includes(kwl)) score += 8;
            if (desc.includes(kwl)) score += 5;
          });

          // criteria 매칭
          if (criteria) {
            const cWords = criteria.split(/\s+/);
            cWords.forEach(function(w) {
              if (w.length >= 2 && title.includes(w.toLowerCase())) score += 10;
              if (w.length >= 2 && desc.includes(w.toLowerCase())) score += 3;
            });
          }

          // 대출 인기도 가산
          const loans = parseInt(b.loan_count) || 0;
          if (loans > 100) score += 8;
          else if (loans > 50) score += 5;
          else if (loans > 20) score += 3;
          else if (loans > 5) score += 1;

          return { book: b, score };
        });

        // 점수 높은 순 정렬 → 상위 5권
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 5);

        // 결과 포맷
        const bookResults = top.map(function(item) {
          const isbn = item.book.isbn13 || item.book.isbn;
          const detailUrl = `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&mainSearchType=on&search_text=${isbn}`;
          return {
            bookname: item.book.bookname,
            authors: item.book.authors,
            publisher: item.book.publisher,
            publication_year: item.book.publication_year,
            isbn13: isbn,
            bookImageURL: item.book.bookImageURL,
            loan_count: item.book.loan_count,
            available: item.book._available,
            detailUrl: detailUrl,
            score: item.score
          };
        });

        return json({ reply, criteria, books: bookResults });

      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /library ──
    if (url.pathname === '/library') {
      try {
        const params = new URLSearchParams(url.search);
        const endpoint = params.get('_endpoint');
        params.delete('_endpoint');
        params.set('authKey', LIB_KEY);
        params.set('format', 'json');
        if (!params.has('libCode')) params.set('libCode', LIB_CODE);
        const allowed = ['srchBooks','bookExist','srchLibs'];
        if (!allowed.includes(endpoint)) return jsonErr('허용되지 않은 endpoint', 400);
        const r = await fetch(`${LIB_BASE}/${endpoint}?${params}`);
        const d = await r.json();
        return new Response(JSON.stringify(d), { headers:{'Content-Type':'application/json',...CORS} });
      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /realcheck ── 종로도서관 홈페이지 크롤링 ──
    if (url.pathname === '/realcheck') {
      const isbn = url.searchParams.get('isbn');
      if (!isbn) return jsonErr('isbn 파라미터 필요', 400);
      try {
        const searchUrl = `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&editMode=normal&mainSearchType=on&search_text=${isbn}`;
        const r = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ko-KR,ko;q=0.9',
          }
        });
        const html = await r.text();
        const vCtrlMatch = html.match(/vCtrl="(\d+)"/);
        const vCtrl = vCtrlMatch ? vCtrlMatch[1] : null;
        const available = html.includes('도서대출가능') ||
                          (html.includes('대출가능') && !html.includes('대출불가'));
        const locationMatch = html.match(/자료실\s*:\s*([^<]+)<\/span>/);
        const location = locationMatch ? locationMatch[1].trim() : null;
        const detailUrl = vCtrl
          ? `${JN_BASE}/jnlib/intro/search/detail.do?vLoca=111021&vCtrl=${vCtrl}&isbn=${isbn}&menu_idx=4`
          : `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&mainSearchType=on&search_text=${isbn}`;
        return json({ available, location, vCtrl, detailUrl });
      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /libcode ──
    if (url.pathname === '/libcode') {
      return json({libCode:LIB_CODE,libName:'종로도서관'});
    }

    if (url.pathname==='/'||url.pathname==='/health')
      return json({status:'ok'});

    return jsonErr('Not Found', 404);
  }
};

function json(data) {
  return new Response(JSON.stringify(data), { headers:{'Content-Type':'application/json',...CORS} });
}

function jsonErr(message, status) {
  return new Response(JSON.stringify({error:message}),
    {status, headers:{'Content-Type':'application/json',...CORS}});
}
