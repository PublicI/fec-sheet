var _ = require('lodash'),
    async = require('async'),
    fs = require('fs'),
    models  = require('./models'),
    moment = require('moment'),
    numeral = require('numeral'),
    xlsx = require('xlsx-stream'),
    express = require('express'),
    slug = require('slug'),
    pg = require('pg'),
    QueryStream = require('pg-query-stream');

function moneyFormat(value) {
    return numeral(value).format('0,0.00');
}

function dateFormat(date) {
    return moment(date.coverage_from_date).format('M/D/YYYY');
}

function summaryFormat(filing_id,row,type) {
    var result = [];

    result.push([row.committee_name,'http://docquery.fec.gov/cgi-bin/forms/' + row.filer_committee_id_number + '/' +
            filing_id + '/','http://www.fec.gov/fecviewer/CandidateCommitteeDetail.do?candidateCommitteeId=' +
            row.filer_committee_id_number + '&tabIndex=3']);
        /*
        { v: 'ok', f: 'HYPERLINK("http://docquery.fec.gov/cgi-bin/forms/' + row.filer_committee_id_number + '/' +
            filing_id + '/","This report")'},
        { v: 'ok', f: 'HYPERLINK("http://www.fec.gov/fecviewer/CandidateCommitteeDetail.do?candidateCommitteeId=' +
            row.filer_committee_id_number + '&tabIndex=3","All reports from this committee")' }]);*/
    result.push(['Covering period ' + dateFormat(row.coverage_from_date) +
                    ' through ' + dateFormat(row.coverage_through_date)]);
    result.push(['',
        'Column A This Period',
        'Column B ' + (type == 'pac' ? 'Year' : 'Cycle') + ' to Date']);
    result.push(['Cash on Hand',
        moneyFormat(row.col_a_cash_on_hand_close_of_period)]);
    result.push(['Debts',
        moneyFormat(row.col_a_debts_by)]);
    result.push(['Total Receipts',
        moneyFormat(row.col_a_total_receipts),
        moneyFormat(row.col_b_total_receipts)]);
    if (type == 'pac') {
        result.push(['Independent Expenditures',
            moneyFormat(row.col_a_independent_expenditures),
            moneyFormat(row.col_b_independent_expenditures)]);
    }
    result.push(['Total Disbursements',
        moneyFormat(row.col_a_total_disbursements),
        moneyFormat(row.col_b_total_disbursements)]);

    return result;
}

function getSummary(filing_id,type,cb) {
    models['fec_' + type + '_summary'].findOne({
        where: {
            filing_id: filing_id
        }
    })
    .then(function (summary) {
        if (summary) {
            cb(null,summaryFormat(filing_id,summary.toJSON(),type));
        }
        else {
            cb();
        }
    })
    .catch(cb);
}

function transactionsFormat(transactions) {
    var result = [_.keys(transactions[0].toJSON())];

    return result.concat(transactions.map(function (transaction) {
        return _.values(transaction.toJSON());
    }));
}

function writeTransactions(x,name,filing_id,cb) {
    var conString = process.env.DB_DRIVER + '://' + process.env.DB_USER + ':' + process.env.DB_PASS +
                    '@' + process.env.DB_HOST + ':' + process.env.DB_PORT + '/' + process.env.DB_NAME;

    pg.connect(conString,function(err, client, done) {
        if(err) throw err;

        var sheet = null;

        var sortColumn = name.slice(0,-1) + '_amount';
        if (name == 'debts') {
            sortColumn = 'balance_at_close_this_period';
        }
        if (name == 'loans') {
            sortColumn = 'loan_balance';
        }

        var query = new QueryStream('SELECT * FROM fec_' + name +
                                    ' WHERE filing_id = $1 ORDER BY ' +
                                    sortColumn +
                                    ' DESC LIMIT 1000000;',
                                    [filing_id]);

        var first = true;

        var stream = client
            .query(query)
            .on('data',function (row) {
                if (first) {
                    sheet = x.sheet(name);

                    sheet.write(_.keys(row));

                    first = false;
                }

                sheet.write(_.values(row).map(function (val) {
                    if (val === null) {
                        return '';
                    }
                    return val;
                }));
            })
            .on('end',function () {
                if (sheet) {
                    sheet.end();
                }

                done();

                cb();
            })
            .on('error',function (err) {
                if (sheet) {
                    sheet.end();
                }

                done();

                cb(err);
            });
    });
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

function getFiling(filing_id,cb) {
    models.fec_filing.findOne({
        where: {
            filing_id: filing_id
        }
    })
    .then(function (filing) {
        cb(null,filing);
    })
    .catch(cb);
}

function writeSheet(x,name,rows) {
    sheet = x.sheet(name);
    rows.forEach(function (row) {
        sheet.write(row);
    });
    sheet.end();
}

var app = express();

app.get('/sheet/:filing_id.xlsx', function(req, res, next) {
    filing_id = req.params.filing_id;

    getFiling(filing_id,function (err,filing) {
        if (err || filing === null) {
            next(err);
            return;
        }

        var x = xlsx();

        async.waterfall([function (cb) {
            getSummary(filing_id,'presidential',function (err,result) {
                if (err) {
                    cb(err);
                    return;
                }

                if (typeof result != 'undefined' && result) {
                    res.setHeader('Content-disposition', 'attachment; filename=' + filing_id + '-' + slug(result[0][0]) + '.xlsx');
                    // res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    x.pipe(res);

                    writeSheet(x,'summary',result);
                }

                cb();
            });
        },function (cb) {
            getSummary(filing_id,'pac',function (err,result) {
                if (err) {
                    cb(err);
                    return;
                }

                if (typeof result != 'undefined' && result) {
                    res.setHeader('Content-disposition', 'attachment; filename=' + filing_id + '-' + slug(result[0][0]) + '.xlsx');
                    // res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    x.pipe(res);
                    
                    writeSheet(x,'summary',result);
                }

                cb();
            });
        },function (cb) {
            writeTransactions(x,'contributions',filing_id,cb);
        },function (cb) {
            writeTransactions(x,'expenditures',filing_id,cb);
        },function (cb) {
            writeTransactions(x,'debts',filing_id,cb);
        },function (cb) {
            writeTransactions(x,'loans',filing_id,cb);
        }],function (err) {
            if (err) {
                next(err);
            }

            x.finalize();
        });
    });
});

app.use(function(req, res, next){
    res.status(404).send('Filing not available yet');
});

app.listen(8080);
