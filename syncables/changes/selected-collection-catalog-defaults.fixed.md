Selected collection reads now validate and apply catalog query defaults before
restricting the read model. A default for another declared collection no
longer prevents a selected read or requires unrelated path parameters, and
unknown or ambiguous defaults still fail before any request.
