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
    clientPackages: [
      { amount: 10, price_pln: 19.99 },
      { amount: 20, price_pln: 34.99 },
      { amount: 50, price_pln: 74.99 },
      { amount: 100, price_pln: 139.99 },
    ],
    paymentOperator: "Przelewy24 (DialCom24 Sp. z o.o.)",
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
