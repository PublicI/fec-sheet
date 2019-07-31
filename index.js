const _ = require('lodash'),
    async = require('async'),
    fs = require('fs'),
    models = require('./models'),
    moment = require('moment'),
    numeral = require('numeral'),
    xlsx = require('xlsx-stream'),
    express = require('express'),
    slug = require('slug'),
    pg = require('pg'),
    QueryStream = require('pg-query-stream');

const currencyColumns = [
    'beginning_balance_this_period',
    'incurred_amount_this_period',
    'payment_amount_this_period',
    'balance_at_close_this_period',
    'expenditure_amount',
    'contribution_amount',
    'contribution_aggregate',
    'loan_amount_original',
    'loan_payment_to_date',
    'loan_balance'
];

function moneyFormat(val) {
    return { v: parseFloat(val), nf: '$#,##0.00' };
}

function dateFormat(date) {
    return moment(date).format('M/D/YYYY');
}

function summaryFormat(filing_id, row, type) {
    const result = [];

    result.push([
        row.committee_name,
        {
            v: 'ok',
            f: `HYPERLINK("http://docquery.fec.gov/cgi-bin/forms/${
                row.filer_committee_id_number
            }/${filing_id}/","This report")`
        },
        {
            v: 'ok',
            f: `HYPERLINK("http://www.fec.gov/fecviewer/CandidateCommitteeDetail.do?candidateCommitteeId=${
                row.filer_committee_id_number
            }&tabIndex=3","All reports from this committee")`
        }
    ]);
    result.push([
        `Covering period ${dateFormat(
            row.coverage_from_date
        )} through ${dateFormat(row.coverage_through_date)}`
    ]);
    result.push([
        '',
        'Column A This Period',
        `Column B ${type == 'pac' ? 'Year' : 'Cycle'} to Date`
    ]);
    result.push([
        'Cash on Hand',
        moneyFormat(row.col_a_cash_on_hand_close_of_period)
    ]);
    result.push(['Debts', moneyFormat(row.col_a_debts_by)]);
    result.push([
        'Total Receipts',
        moneyFormat(row.col_a_total_receipts),
        moneyFormat(row.col_b_total_receipts)
    ]);
    if (type == 'pac') {
        result.push([
            'Independent Expenditures',
            moneyFormat(row.col_a_independent_expenditures),
            moneyFormat(row.col_b_independent_expenditures)
        ]);
    }
    result.push([
        'Total Disbursements',
        moneyFormat(row.col_a_total_disbursements),
        moneyFormat(row.col_b_total_disbursements)
    ]);

    return result;
}

function getSummary(filing_id, type, cb) {
    models[`fec_${type}_summary`]
        .findOne({
            where: {
                filing_id
            }
        })
        .then(summary => {
            if (summary) {
                cb(null, summaryFormat(filing_id, summary.toJSON(), type));
            } else {
                cb();
            }
        })
        .catch(cb);
}

function transactionsFormat(transactions) {
    const result = [_.keys(transactions[0].toJSON())];

    return result.concat(
        transactions.map(transaction => _.values(transaction.toJSON()))
    );
}

function writeTransactions(x, name, filing_id, cb) {
    console.log(name);
    const conString = `${process.env.DB_DRIVER}://${process.env.DB_USER}:${
        process.env.DB_PASS
    }@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

    pg.connect(
        conString,
        (err, client, done) => {
            if (err) {
                cb(err);
                return;
            }

            let sheet = null;

            let sortColumn = `${name.slice(0, -1)}_amount`;
            if (name == 'debts') {
                sortColumn = 'balance_at_close_this_period';
            }
            if (name == 'loans') {
                sortColumn = 'loan_balance';
            }
            if (name == 'ies') {
                sortColumn = 'expenditure_amount';
            }

            const query = new QueryStream(
                `SELECT * FROM fec_${name} WHERE filing_id = $1 ORDER BY ${sortColumn} DESC LIMIT 100000;`,
                [filing_id]
            );

            let first = true;

            const stream = client
                .query(query)
                .on('data', row => {
                    if (first) {
                        sheet = x.sheet(name, {
                            columnsWidth: 20
                        });

                        sheet.write(_.keys(row));

                        first = false;
                    }

                    sheet.write(
                        _.values(
                            _.mapValues(row, (val, key) => {
                                if (val === null) {
                                    return '';
                                } else if (currencyColumns.includes(key)) {
                                    return moneyFormat(val);
                                }
                                return val;
                            })
                        )
                    );
                })
                .on('end', () => {
                    if (sheet) {
                        sheet.end();
                    }

                    done();

                    cb();
                })
                .on('error', err => {
                    if (sheet) {
                        sheet.end();
                    }

                    done();

                    cb(err);
                });
        }
    );
    /*
        models['fec_' + type].findAll({
            where: {
                filing_id: filing_id
            },
            limit: 10000,
            order: [[type + '_amount','DESC']]
        })
        .then(function (transactions) {
            if (transactions && transactions.length > 0) {
                cb(null,transactionsFormat(transactions));
            }
            else {
                cb();
            }
        })
        .catch(cb);*/
}

function getFiling(filing_id, cb) {
    models.fec_filing
        .findOne({
            where: {
                filing_id
            }
        })
        .then(filing => {
            cb(null, filing);
        })
        .catch(cb);
}

function writeSheet(x, name, rows) {
    console.log(name);
    sheet = x.sheet(name, {
        columnsWidth: 20
    });
    rows.forEach(row => {
        sheet.write(row);
    });
    sheet.end();
}

const app = express();

app.get('/:filing_id.xlsx', (req, res, next) => {
    filing_id = req.params.filing_id;

    getFiling(filing_id, (err, filing) => {
        if (err || filing === null) {
            next(err);
            return;
        }

        const x = xlsx();

        async.waterfall(
            [
                cb => {
                    getSummary(filing_id, 'presidential', (err, result) => {
                        if (err) {
                            cb(err);
                            return;
                        }

                        if (typeof result != 'undefined' && result) {
                            res.setHeader(
                                'Content-disposition',
                                `attachment; filename=${filing_id}-${slug(
                                    result[0][0]
                                )}.xlsx`
                            );
                            // res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                            x.pipe(res);

                            writeSheet(x, 'summary', result);
                        }

                        cb();
                    });
                },
                cb => {
                    getSummary(filing_id, 'pac', (err, result) => {
                        if (err) {
                            cb(err);
                            return;
                        }

                        if (typeof result != 'undefined' && result) {
                            res.setHeader(
                                'Content-disposition',
                                `attachment; filename=${filing_id}-${slug(
                                    result[0][0]
                                )}.xlsx`
                            );
                            // res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                            x.pipe(res);

                            writeSheet(x, 'summary', result);
                        }

                        cb();
                    });
                },
                cb => {
                    getSummary(filing_id, 'campaign', (err, result) => {
                        if (err) {
                            cb(err);
                            return;
                        }

                        if (typeof result != 'undefined' && result) {
                            res.setHeader(
                                'Content-disposition',
                                `attachment; filename=${filing_id}-${slug(
                                    result[0][0]
                                )}.xlsx`
                            );
                            // res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                            x.pipe(res);

                            writeSheet(x, 'summary', result);
                        }

                        cb();
                    });
                },
                cb => writeTransactions(x, 'contributions', filing_id, cb),
                cb => writeTransactions(x, 'expenditures', filing_id, cb),
                cb => writeTransactions(x, 'ies', filing_id, cb),
                cb => writeTransactions(x, 'debts', filing_id, cb),
                cb => writeTransactions(x, 'loans', filing_id, cb)
            ],
            err => {
                if (err) {
                    next(err);
                }

                console.log('finalizing');

                x.finalize();
            }
        );
    });
});

app.use((req, res, next) => {
    res.status(404).send('Filing not available yet');
});

app.listen(process.env.PORT || 8080);
