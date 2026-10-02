// Test setup: pin the i18n catalog to English (the primary language) so assertions are
// deterministic regardless of the host machine's UI language.
import { setLocale } from '@/lib/i18n';

setLocale('en');
