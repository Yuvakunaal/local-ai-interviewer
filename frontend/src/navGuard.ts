/** In-app navigation guard (hash routes): a page with unsaved changes can stop a route change and ask first. */
type Guard = (nextHash: string) => boolean;      // true = may leave now
let guard: Guard | null = null;
export const setNavGuard = (g: Guard | null) => { guard = g; };
export const mayNavigate = (nextHash: string) => (guard ? guard(nextHash) : true);
