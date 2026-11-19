const categoryLabels: Record<string, string> = {
  electronics: 'Էլեկտրոնիկա',
  'computers-accessories': 'Համակարգիչներ և պարագաներ',
  clothing: 'Նորաձևություն և հագուստ',
  'shoes-bags': 'Կոշիկ և պայուսակներ',
  'home-kitchen': 'Տուն և խոհանոց',
  'furniture-home-decor': 'Կահույք և տան դեկոր',
  beauty: 'Գեղեցկություն և խնամք',
  sports: 'Սպորտ և բացօթյա',
  books: 'Գրքեր և գրենական պիտույքներ',
  accessories: 'Աքսեսուարներ',
  toys: 'Խաղալիքներ և խաղեր',
  'automotive-accessories': 'Ավտոմեքենայի պարագաներ',
  'grocery-essentials': 'Մթերք և ամենօրյա անհրաժեշտություն',
};

export function categoryLabel(slug: string, fallback: string): string {
  return categoryLabels[slug] ?? fallback;
}
