export const APP_CONFIG = {
  brandName: "Szepty Anielskie",
  domain: "szeptyanielskie.pl",
  company: {
    ownerFullName: "Paweł Cepak",
    businessName: "PCF",
    nip: "9691574954",
    address: "Wieczorka 20B/7, 44-120 Pyskowice",
    email: "cepakpawel94@gmail.com",
  },
  pricing: {
    currency: "PLN",
    /* Pakiety: ta sama lista jest używana przy naliczaniu Stripe/iMoje, w panelu i na /informacje-ceny.html (API).
       Na serwerze możesz nadpisać kwoty zmiennymi środowiskowymi CLIENT_PKG_10_PLN, CLIENT_PKG_20_PLN, itd. */
    clientPackages: [
      { amount: 10, price_pln: 16.99 },
      { amount: 20, price_pln: 29.99 },
      { amount: 50, price_pln: 69.99 },
      { amount: 100, price_pln: 129.98 },
    ],
    paymentOperator: "ING Bank Śląski S.A. (bramka płatności iMoje)",
  },
  legal: {
    complaintsEmail: "cepakpawel94@gmail.com",
    complaintsResponseBusinessDays: 14,
    regulationChangeNoticeDays: 14,
    taxRetentionYears: 5,
  },
  privacy: {
    registrationFields: ["imię", "adres e-mail", "miasto"],
    automaticFields: ["adres IP", "dane o sesjach i aktywności w serwisie"],
  },
};
