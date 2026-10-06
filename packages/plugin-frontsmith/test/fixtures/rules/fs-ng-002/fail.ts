export class A {
  constructor(private s: Sanitizer) {}
  html(v: string) {
    return this.s.bypassSecurityTrustHtml(v);
  }
}
